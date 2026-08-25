import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';

import { config } from './config.mjs';
import { Checkpoint } from './state.mjs';
import { NdjsonWriter, writeJsonAtomic } from './writer.mjs';
import {
  METADATA_FIELDS,
  METADATA_FIELDS_FAT,
  SOURCE_FIELDS,
  PUBLISHER_FIELDS,
  MEDIA_COLLECTION_FIELDS,
  ME_FIELDS,
  DICTIONARIES,
  RECORD_STATUSES,
} from './fields.mjs';

const nowIso = () => new Date().toISOString();
const fmtInt = (n) => Number(n).toLocaleString('de-DE');

/** Serialisiert Schreibzugriffe: parallele Worker duerfen Zeilen nicht verschraenken. */
class WriteLock {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}

/** Liest bereits geschriebene IDs aus einem NDJSON(.gz) — fuer Resume-Dedupe. */
async function loadExistingIds(path, idField = 'id') {
  const ids = new Set();
  if (!existsSync(path)) return ids;
  const stream = path.endsWith('.gz')
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const id = JSON.parse(line)[idField];
      if (id) ids.add(id);
    } catch {
      // Abgebrochene letzte Zeile eines harten Abbruchs: ignorieren.
    }
  }
  return ids;
}

/**
 * Generischer, wiederaufnehmbarer Crawler fuer alle `*.search`-Endpunkte.
 * Paging ist bei SODIX 0-basiert (verifiziert gegen api3.sodix.de).
 */
async function crawlPaged(client, {
  name,
  rootField,
  fields,
  filter = null,
  orderBy = null,
  pageSize = config.pageSize,
  outDir,
  gzip = false,
  fresh = false,
  idField = 'id',
  limit = Infinity,
  onProgress = null,
}) {
  const outPath = join(outDir, `${name}.ndjson${gzip ? '.gz' : ''}`);
  const checkpoint = new Checkpoint(join(outDir, `${name}.checkpoint.json`));

  const filterArg = filter ? `, filter: ${toGraphQLLiteral(filter)}` : '';
  const orderArg = orderBy ? `, orderBy: ${toGraphQLLiteral(orderBy)}` : '';
  const buildQuery = (page, size = pageSize) => `query Crawl {
  ${rootField} {
    search(pageInput: { page: ${page}, pageSize: ${size}${orderArg} }${filterArg}) {
      totalCount
      data {${fields}}
    }
  }
}`;
  const signature = JSON.stringify({ rootField, filter, orderBy, pageSize, fields: fields.length });

  if (fresh || !checkpoint.matches(signature)) {
    if (!fresh && checkpoint.isResume()) {
      console.error(`[${name}] Abfrage hat sich geaendert — Fortschritt wird verworfen.`);
    }
    checkpoint.reset();
  }
  const resuming = checkpoint.isResume();

  // Erste Seite liefert totalCount und dient als Verbindungstest.
  const first = await client.request(buildQuery(0), {}, { label: `${name} page 0` });
  const totalCount = first[rootField].search.totalCount;
  checkpoint.init(signature, totalCount);

  const target = Math.min(totalCount, limit);
  const totalPages = Math.ceil(target / pageSize);
  console.error(
    `[${name}] ${fmtInt(totalCount)} Datensaetze` +
      (target < totalCount ? ` (limitiert auf ${fmtInt(target)})` : '') +
      ` · ${fmtInt(totalPages)} Seiten x ${pageSize} · ${client.maxInFlight} parallel` +
      (resuming ? ` · Resume: ${fmtInt(checkpoint.donePages.size)} Seiten bereits erledigt` : '')
  );

  const writer = new NdjsonWriter(outPath, { gzip, append: resuming });
  const lock = new WriteLock();
  const seen = resuming ? await loadExistingIds(outPath, idField) : new Set();
  if (resuming) console.error(`[${name}] ${fmtInt(seen.size)} bereits gespeicherte IDs geladen`);

  let written = 0;
  let duplicates = 0;
  /** Offsets, die selbst einzeln nicht lesbar sind (serverseitig defekte Datensaetze). */
  const unreadable = [];
  let nextPage = 0;
  let highestPage = totalPages - 1;
  const startedAt = Date.now();
  let lastReport = 0;

  const persist = (records) =>
    lock.run(async () => {
      const unseen = [];
      for (const record of records) {
        const id = record?.[idField];
        if (id && seen.has(id)) {
          duplicates++;
          continue;
        }
        if (id) seen.add(id);
        unseen.push(record);
      }
      await writer.writeAll(unseen);
      written += unseen.length;
      return unseen.length;
    });

  const report = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = written / Math.max(elapsed, 0.001);
    const done = checkpoint.donePages.size;
    const remaining = Math.max(0, highestPage + 1 - done);
    const eta = rate > 0 ? (remaining * pageSize) / rate : 0;
    console.error(
      `[${name}] ${fmtInt(written)} neu / ${fmtInt(done)} von ${fmtInt(highestPage + 1)} Seiten · ` +
        `${rate.toFixed(1)} Datensaetze/s · ETA ${formatDuration(eta)}` +
        (duplicates ? ` · ${fmtInt(duplicates)} Duplikate uebersprungen` : '')
    );
    if (onProgress) onProgress({ written, pagesDone: done, totalPages: highestPage + 1 });
  };

  // Seite 0 nicht doppelt abfragen.
  if (!checkpoint.donePages.has(0)) {
    const n = await persist(first[rootField].search.data);
    checkpoint.markDone(0, n);
  }
  nextPage = 1;

  /**
   * Naechstkleinere Seitengroesse fuer das Bisect. Muss `size` teilen, damit
   * die Offset-Arithmetik (page = offset / size) aufgeht.
   */
  const shrink = (size) => (size >= 10 && size % 10 === 0 ? size / 10 : 1);

  /**
   * Holt den Offset-Bereich [offset, offset+size) in kleineren Haeppchen, wenn
   * er als ganze Seite nicht ladbar ist.
   *
   * Hintergrund: Einzelne Datensaetze sind serverseitig defekt und beantworten
   * jede Abfrage mit "Exception while fetching data (...) : null" — selbst
   * `{ id }` allein. Ohne Bisect reisst so ein Satz die komplette Seite mit:
   * gemessen 174 von 2.159 Seiten, also bis zu 17.400 verlorene Datensaetze
   * fuer ~174 defekte. Das Bisect rettet die gesunden Nachbarn und protokolliert
   * nur die tatsaechlich unlesbaren Offsets.
   */
  const recoverRange = async (offset, size) => {
    const recovered = [];
    const sub = shrink(size);
    for (let start = offset; start < offset + size; start += sub) {
      try {
        const data = await client.request(
          buildQuery(start / sub, sub),
          {},
          {
            label: `${name} recover @${start}/${sub}`,
            // Hart wiederholen nur dort, wo kein Fallback mehr existiert:
            // auf Zwischenebenen ist der naechste Split der bessere Versuch,
            // auf der 1er-Ebene ist Wiederholen das letzte Mittel.
            maxRetries: sub === 1 ? config.maxRetries : 2,
          }
        );
        recovered.push(...data[rootField].search.data);
      } catch (err) {
        if (sub === 1) {
          unreadable.push({ offset: start, error: String(err.message).slice(0, 200) });
          console.error(`[${name}] Datensatz an Offset ${start} ist serverseitig unlesbar`);
        } else {
          recovered.push(...(await recoverRange(start, sub)));
        }
      }
    }
    return recovered;
  };

  const worker = async () => {
    for (;;) {
      const page = nextPage++;
      if (page > highestPage) return;
      if (checkpoint.donePages.has(page)) continue;
      try {
        // Kleines Retry-Budget auf Seitenebene: das Bisect unten ist der
        // eigentliche Rettungsweg und wiederholt ohnehin mit vollem Budget.
        // Fuenf Backoff-Runden vor jedem Bisect kosten bei einer serverseitig
        // defekten Seite rund eine Minute — bei 174 solchen Seiten eine
        // Dreiviertelstunde Wartezeit ohne jeden Nutzen.
        const data = await client.request(
          buildQuery(page),
          {},
          { label: `${name} page ${page}`, maxRetries: 2 }
        );
        const records = data[rootField].search.data;
        const n = await persist(records);
        checkpoint.markDone(page, n);
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now();
          report();
        }
      } catch (err) {
        // Ganze Seite nicht ladbar: aufteilen und retten, was zu retten ist.
        console.error(
          `[${name}] Seite ${page} nicht ladbar (${String(err.message).slice(0, 90)}) — teile auf`
        );
        try {
          const rescued = await recoverRange(page * pageSize, pageSize);
          const n = await persist(rescued);
          checkpoint.markDone(page, n);
          console.error(
            `[${name}] Seite ${page}: ${rescued.length} von ${pageSize} Datensaetzen gerettet`
          );
        } catch (splitErr) {
          checkpoint.markFailed(page, String(splitErr.message).slice(0, 300));
          console.error(`[${name}] Seite ${page} endgueltig fehlgeschlagen: ${splitErr.message}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: client.maxInFlight }, worker));

  // Nachlauf: Bei ASC-Sortierung wachsen neue Datensaetze am Ende an.
  // Solange der Bestand waehrend des Crawls gewachsen ist, weiter einsammeln.
  if (target >= totalCount) {
    for (let round = 0; round < 5; round++) {
      const check = await client.request(
        buildQuery(highestPage + 1),
        {},
        { label: `${name} tail ${round}` }
      );
      const tail = check[rootField].search.data;
      const newTotal = check[rootField].search.totalCount;
      if (!tail.length) break;
      const n = await persist(tail);
      checkpoint.markDone(highestPage + 1, n);
      console.error(
        `[${name}] Nachlauf: ${fmtInt(tail.length)} weitere Datensaetze (totalCount jetzt ${fmtInt(newTotal)})`
      );
      highestPage += 1;
      nextPage = highestPage + 1;
      const stillMissing = Math.ceil(Math.min(newTotal, limit) / pageSize) - 1;
      if (stillMissing > highestPage) {
        highestPage = stillMissing;
        await Promise.all(Array.from({ length: client.maxInFlight }, worker));
      }
    }
  }

  const closed = await writer.close();
  report();
  checkpoint.finish({
    outFile: closed.path,
    written,
    duplicates,
    unreadable,
    totalCountAtEnd: totalCount,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  });

  if (unreadable.length) {
    const path = join(outDir, `${name}.unreadable.json`);
    writeJsonAtomic(path, {
      note:
        'Diese Offsets liefern serverseitig "Exception while fetching data : null" — ' +
        'auch bei Abfrage eines einzelnen Feldes. Clientseitig nicht behebbar, ' +
        'nur ueber den SODIX-Support klaerbar.',
      apiUrl: config.apiUrl,
      filter,
      orderBy: 'createdAt ASC',
      pageSize,
      count: unreadable.length,
      offsets: unreadable,
    });
    console.error(
      `[${name}] ${unreadable.length} serverseitig unlesbare Datensaetze protokolliert in ${path}`
    );
  }

  const failed = [...checkpoint.failedPages];
  if (failed.length) {
    console.error(
      `[${name}] ACHTUNG: ${failed.length} Seiten fehlgeschlagen (${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ', …' : ''}). ` +
        `Erneuter Aufruf desselben Befehls holt genau diese Seiten nach.`
    );
  }

  return {
    name,
    file: closed.path,
    // `written` = in diesem Lauf neu geschrieben, `records` = Gesamtbestand der
    // Datei. Bei einem Resume ohne offene Seiten ist written 0, obwohl die
    // Datei vollstaendig ist — beides getrennt auszuweisen verhindert die
    // Fehllesung "0 Datensaetze".
    records: seen.size || written,
    written,
    duplicates,
    unreadable: unreadable.length,
    totalCount,
    failedPages: failed,
    complete: failed.length === 0,
  };
}

/** Wandelt JS-Werte in GraphQL-Literale (Enums bleiben unquotiert). */
function toGraphQLLiteral(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Enum) return value.name;
  if (Array.isArray(value)) return `[${value.map(toGraphQLLiteral).join(', ')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `{ ${entries.map(([k, v]) => `${k}: ${toGraphQLLiteral(v)}`).join(', ')} }`;
}

/** Marker fuer GraphQL-Enums, die nicht in Anfuehrungszeichen gehoeren. */
export class Enum {
  constructor(name) {
    this.name = name;
  }
}
export const gqlEnum = (name) => new Enum(name);

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export async function crawlMetadata(client, opts) {
  const filter = { ...(opts.filter || {}) };
  if (opts.statuses?.length) filter.recordStatusIn = opts.statuses.map(gqlEnum);
  if (opts.tenantOnly) filter.tenantRecordStatus = true;
  if (opts.since) filter.time = { ...(filter.time || {}), anyUpdate: { from: opts.since } };
  if (opts.createdSince) {
    filter.time = { ...(filter.time || {}), createdAt: { from: opts.createdSince } };
  }

  return crawlPaged(client, {
    ...opts,
    name: opts.name || 'metadata',
    rootField: 'metadata',
    fields: opts.fat ? METADATA_FIELDS_FAT : METADATA_FIELDS,
    filter: Object.keys(filter).length ? filter : null,
    // ASC nach createdAt: neue Datensaetze landen am Ende und verschieben
    // damit keine bereits gelesenen Seiten.
    orderBy: { createdAt: gqlEnum('ASC') },
  });
}

export const crawlSources = (client, opts) =>
  crawlPaged(client, {
    ...opts,
    name: 'sources',
    rootField: 'source',
    fields: SOURCE_FIELDS,
    pageSize: Math.min(opts.pageSize ?? 100, 100),
    orderBy: null,
  });

export const crawlPublishers = (client, opts) =>
  crawlPaged(client, {
    ...opts,
    name: 'publishers',
    rootField: 'publisher',
    fields: PUBLISHER_FIELDS,
    pageSize: Math.min(opts.pageSize ?? 100, 100),
    orderBy: null,
  });

export const crawlCollections = (client, opts) =>
  crawlPaged(client, {
    ...opts,
    name: 'media-collections',
    rootField: 'mediaCollection',
    fields: MEDIA_COLLECTION_FIELDS,
    pageSize: Math.min(opts.pageSize ?? 100, 100),
    orderBy: null,
  });

/** Alle Vokabular-Listen; eine Abfrage pro Liste (der Server mag keine Mega-Queries). */
export async function crawlDictionary(client, { outDir }) {
  const result = {};
  for (const { field, selection } of DICTIONARIES) {
    const query = `query Dictionary { dictionary { ${field} { ${selection} } } }`;
    try {
      const data = await client.request(query, {}, { label: `dictionary.${field}` });
      result[field] = data.dictionary[field];
      console.error(`[dictionary] ${field}: ${fmtInt(result[field]?.length ?? 0)} Einträge`);
    } catch (err) {
      result[field] = { error: String(err.message).slice(0, 300) };
      console.error(`[dictionary] ${field}: FEHLER ${err.message}`);
    }
  }
  const path = join(outDir, 'dictionary.json');
  writeJsonAtomic(path, { fetchedAt: nowIso(), apiUrl: config.apiUrl, dictionaries: result });
  return { name: 'dictionary', file: path, records: Object.keys(result).length, complete: true };
}

export async function crawlMe(client, { outDir }) {
  const data = await client.request(`query Auth { auth { me { ${ME_FIELDS} } } }`, {}, { label: 'me' });
  const path = join(outDir, 'account.json');
  writeJsonAtomic(path, { fetchedAt: nowIso(), apiUrl: config.apiUrl, me: data.auth.me });
  console.error(
    `[me] ${data.auth.me?.username} · Mandant ${data.auth.me?.currentTenant} · Rollen ${(data.auth.me?.roles || []).join(', ')}`
  );
  return { name: 'me', file: path, records: 1, complete: true };
}

/** Zaehlt Datensaetze pro Status und Mandantenfreigabe, ohne Daten zu laden. */
export async function crawlStats(client, { outDir }) {
  const counts = {};
  for (const status of RECORD_STATUSES) {
    const query = `query Count { metadata { search(pageInput: { page: 0, pageSize: 1 }, filter: { recordStatusIn: [${status}] }) { totalCount } } }`;
    const data = await client.request(query, {}, { label: `count ${status}` });
    counts[status] = data.metadata.search.totalCount;
    console.error(`[stats] ${status.padEnd(12)} ${fmtInt(counts[status]).padStart(9)}`);
  }
  const tenantQuery = `query Count { metadata { search(pageInput: { page: 0, pageSize: 1 }, filter: { recordStatusIn: [ACTIVATED], tenantRecordStatus: true }) { totalCount } } }`;
  const tenant = await client.request(tenantQuery, {}, { label: 'count tenant' });
  counts.ACTIVATED_TENANT_RELEASED = tenant.metadata.search.totalCount;
  console.error(`[stats] ${'ACTIVATED+Mandant'.padEnd(12)} ${fmtInt(counts.ACTIVATED_TENANT_RELEASED).padStart(9)}`);

  for (const [root, label] of [
    ['source', 'sources'],
    ['publisher', 'publishers'],
    ['mediaCollection', 'mediaCollections'],
  ]) {
    const data = await client.request(
      `query Count { ${root} { search(pageInput: { page: 0, pageSize: 1 }) { totalCount } } }`,
      {},
      { label: `count ${root}` }
    );
    counts[label] = data[root].search.totalCount;
    console.error(`[stats] ${label.padEnd(12)} ${fmtInt(counts[label]).padStart(9)}`);
  }

  const path = join(outDir, 'stats.json');
  writeJsonAtomic(path, { fetchedAt: nowIso(), apiUrl: config.apiUrl, counts });
  return { name: 'stats', file: path, records: Object.keys(counts).length, complete: true };
}
