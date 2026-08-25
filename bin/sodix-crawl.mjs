#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../src/config.mjs';
import { SodixClient } from '../src/client.mjs';
import { writeJsonAtomic } from '../src/writer.mjs';
import {
  crawlMetadata,
  crawlSources,
  crawlPublishers,
  crawlCollections,
  crawlDictionary,
  crawlMe,
  crawlStats,
} from '../src/crawl.mjs';
import { RECORD_STATUSES } from '../src/fields.mjs';

const HELP = `sodix-crawl — holt Inhalte aus der SODIX GraphQL API v3

Aufruf:
  node bin/sodix-crawl.mjs <befehl…> [optionen]

Befehle:
  all           dictionary + sources + publishers + collections + metadata (Vollabzug)
  metadata      Metadatensaetze (der grosse Teil, ~140k bei ACTIVATED)
  sources       Quellen
  publishers    Herausgeber
  collections   Medien-Sammlungen (mediaCollection)
  dictionary    alle 21 Vokabular-Listen
  me            eigener Account/Mandant
  stats         nur Datensatzzahlen zaehlen, nichts herunterladen
  schema        vollstaendiges GraphQL-Schema (Introspection) als JSON

Optionen:
  --status <liste>   Kommaliste, Default ACTIVATED. Erlaubt: ${RECORD_STATUSES.join(',')}
                     --status all fuer jeden Status
  --tenant-only      nur vom Mandanten freigeschaltete Datensaetze (tenantRecordStatus: true)
  --since <datum>    nur seit Datum geaenderte Datensaetze (time.anyUpdate.from), z. B. 2026-08-01
  --created-since <d> nur seit Datum erstellte Datensaetze (time.createdAt.from)
  --page-size <n>    Datensaetze pro Anfrage, Default ${config.pageSize}, max 1000
  --concurrency <n>  parallele Anfragen, Default ${config.concurrency}
  --limit <n>        nach n Datensaetzen aufhoeren (fuer Tests)
  --out <dir>        Zielverzeichnis, Default ${config.outDir}
  --gzip             NDJSON gzip-komprimiert schreiben
  --fat              Publisher in jeden Metadatensatz einbetten (ca. 11x langsamer)
  --fresh            Checkpoint ignorieren und komplett neu crawlen
  --quiet            weniger Log-Ausgaben
  -h, --help         diese Hilfe

Beispiele:
  node bin/sodix-crawl.mjs stats
  node bin/sodix-crawl.mjs all --gzip
  node bin/sodix-crawl.mjs metadata --status all --page-size 200 --concurrency 6
  node bin/sodix-crawl.mjs metadata --since 2026-08-01        # taeglicher Delta-Lauf
  node bin/sodix-crawl.mjs metadata --limit 500 --fresh       # schneller Testlauf

Ausgabe: ein NDJSON pro Datensatzart (eine Zeile = ein Datensatz) plus
<name>.checkpoint.json. Ein abgebrochener Lauf wird durch denselben Befehl
genau dort fortgesetzt, wo er stehen geblieben ist.
`;

function parseArgs(argv) {
  const opts = {
    commands: [],
    statuses: ['ACTIVATED'],
    tenantOnly: false,
    since: null,
    createdSince: null,
    pageSize: config.pageSize,
    concurrency: config.concurrency,
    limit: Infinity,
    outDir: config.outDir,
    gzip: false,
    fat: false,
    fresh: false,
    quiet: false,
  };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} braucht einen Wert`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--status': {
        const value = need(i++, arg);
        opts.statuses =
          value.toLowerCase() === 'all'
            ? [...RECORD_STATUSES]
            : value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        for (const s of opts.statuses) {
          if (!RECORD_STATUSES.includes(s)) throw new Error(`Unbekannter Status: ${s}`);
        }
        break;
      }
      case '--tenant-only':
        opts.tenantOnly = true;
        break;
      case '--since':
        opts.since = need(i++, arg);
        break;
      case '--created-since':
        opts.createdSince = need(i++, arg);
        break;
      case '--page-size':
        opts.pageSize = Math.min(1000, Math.max(1, Number(need(i++, arg))));
        break;
      case '--concurrency':
        opts.concurrency = Math.max(1, Number(need(i++, arg)));
        break;
      case '--limit':
        opts.limit = Math.max(1, Number(need(i++, arg)));
        break;
      case '--out':
        opts.outDir = need(i++, arg);
        break;
      case '--gzip':
        opts.gzip = true;
        break;
      case '--fat':
        opts.fat = true;
        break;
      case '--fresh':
        opts.fresh = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unbekannte Option: ${arg}`);
        opts.commands.push(arg.toLowerCase());
    }
  }
  return opts;
}

/** Volles Schema per Introspection — die API blockt zu breite Anfragen,
 *  darum getrennte, schlanke Requests. */
async function dumpSchema(client, outDir) {
  const types = await client.request(
    `{ __schema { queryType { name } types { name kind description
        fields { name description type { ...T } args { name type { ...T } } }
        enumValues { name description }
        interfaces { name } } } }
     fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`,
    {},
    { label: 'schema types' }
  );
  const inputs = {};
  for (const t of types.__schema.types) {
    if (t.kind !== 'INPUT_OBJECT' || t.name.startsWith('__')) continue;
    const data = await client.request(
      `{ __type(name: "${t.name}") { name inputFields { name description
          type { kind name ofType { kind name ofType { kind name } } } } } }`,
      {},
      { label: `schema input ${t.name}` }
    );
    inputs[t.name] = data.__type?.inputFields ?? [];
  }
  const path = join(outDir, 'schema.json');
  writeJsonAtomic(path, {
    fetchedAt: new Date().toISOString(),
    apiUrl: config.apiUrl,
    schema: types.__schema,
    inputFields: inputs,
  });
  console.error(
    `[schema] ${types.__schema.types.length} Typen, ${Object.keys(inputs).length} Input-Typen`
  );
  return { name: 'schema', file: path, records: types.__schema.types.length, complete: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.commands.length) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const commands = opts.commands.includes('all')
    ? ['dictionary', 'me', 'sources', 'publishers', 'collections', 'metadata']
    : opts.commands;

  mkdirSync(opts.outDir, { recursive: true });
  const client = new SodixClient({ concurrency: opts.concurrency, verbose: !opts.quiet });
  await client.login();

  const startedAt = Date.now();
  const results = [];
  const shared = {
    outDir: opts.outDir,
    gzip: opts.gzip,
    fresh: opts.fresh,
    pageSize: opts.pageSize,
    limit: opts.limit,
  };

  for (const command of commands) {
    console.error(`\n=== ${command} ===`);
    switch (command) {
      case 'metadata':
        results.push(
          await crawlMetadata(client, {
            ...shared,
            statuses: opts.statuses,
            tenantOnly: opts.tenantOnly,
            since: opts.since,
            createdSince: opts.createdSince,
            fat: opts.fat,
          })
        );
        break;
      case 'sources':
        results.push(await crawlSources(client, shared));
        break;
      case 'publishers':
        results.push(await crawlPublishers(client, shared));
        break;
      case 'collections':
        results.push(await crawlCollections(client, shared));
        break;
      case 'dictionary':
        results.push(await crawlDictionary(client, shared));
        break;
      case 'me':
        results.push(await crawlMe(client, shared));
        break;
      case 'stats':
        results.push(await crawlStats(client, shared));
        break;
      case 'schema':
        results.push(await dumpSchema(client, opts.outDir));
        break;
      default:
        throw new Error(`Unbekannter Befehl: ${command}. --help zeigt alle Befehle.`);
    }
  }

  const summary = {
    finishedAt: new Date().toISOString(),
    apiUrl: config.apiUrl,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    options: {
      commands,
      statuses: opts.statuses,
      tenantOnly: opts.tenantOnly,
      since: opts.since,
      createdSince: opts.createdSince,
      pageSize: opts.pageSize,
      concurrency: opts.concurrency,
      gzip: opts.gzip,
      fat: opts.fat,
    },
    httpStats: client.stats,
    results,
  };
  writeJsonAtomic(join(opts.outDir, 'run-summary.json'), summary);

  console.error('\n=== Zusammenfassung ===');
  for (const r of results) {
    const delta =
      r.written !== undefined && r.written !== r.records ? ` (davon ${r.written} neu)` : '';
    const lost = r.unreadable ? `  ${r.unreadable} serverseitig unlesbar` : '';
    console.error(
      `  ${r.name.padEnd(17)} ${String(r.records).padStart(9)} Datensaetze${delta}  ${r.file}` +
        lost +
        (r.complete === false ? `  UNVOLLSTAENDIG (${r.failedPages.length} Seiten offen)` : '')
    );
  }
  console.error(
    `  Dauer ${summary.durationSeconds}s · ${client.stats.requests} Requests · ` +
      `${client.stats.retries} Retries · ${(client.stats.bytes / 1e6).toFixed(1)} MB empfangen`
  );

  process.exit(results.some((r) => r.complete === false) ? 2 : 0);
}

main().catch((err) => {
  console.error(`\nFEHLER: ${err.message}`);
  if (process.env.SODIX_DEBUG) console.error(err.stack);
  process.exit(1);
});
