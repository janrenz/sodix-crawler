#!/usr/bin/env node
/**
 * SODIX-NDJSON → AMB-JSONL.
 *
 * Ausgabe geht direkt in den Konverter von edufeed-org:
 *   node bin/sodix-to-amb.mjs --filter cc -o data/amb.jsonl
 *   amb-convert amb:nostr data/amb.jsonl --nsec $NOSTR_NSEC -o data/events.jsonl
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { dirname } from 'node:path';
import { once } from 'node:events';

import { sodixToAmb, FILTERS } from '../src/amb.mjs';

const HELP = `sodix-to-amb — bildet SODIX-Metadaten auf AMB-JSON-LD ab

Aufruf:
  node bin/sodix-to-amb.mjs [optionen]

Optionen:
  -i, --in <datei>     SODIX-NDJSON, Default data/metadata.ndjson (.gz erkannt)
  -o, --out <datei>    AMB-JSONL, Default data/amb.jsonl ("-" fuer stdout)
  --filter <name>      cc | free | activated | all   (Default cc)
                         cc        nur CC-lizenziert, ACTIVATED
                         free      ACTIVATED und paymentType NOT_PAID
                         activated jeder aktive Datensatz
                         all       alles im Dump
  --id-scheme <name>   urn | media   (Default urn)
                         urn    urn:sodix:<sodixId>          stabil
                         media  die Medien-URL                dereferenzierbar
  --limit <n>          nach n abgebildeten Saetzen aufhoeren
  --report <datei>     Statistik als JSON ablegen
  -h, --help           diese Hilfe

Die AMB-id wird zum Nostr-d-Tag und legt damit die Event-Identitaet ueber alle
kuenftigen Updates fest. --id-scheme nachtraeglich zu wechseln erzeugt fuer
jeden Datensatz ein zweites, unverknuepftes Event.
`;

function parseArgs(argv) {
  const opts = {
    input: 'data/metadata.ndjson',
    output: 'data/amb.jsonl',
    filter: 'cc',
    idScheme: 'urn',
    limit: Infinity,
    report: null,
  };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} braucht einen Wert`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-i': case '--in': opts.input = need(i++, arg); break;
      case '-o': case '--out': opts.output = need(i++, arg); break;
      case '--filter': opts.filter = need(i++, arg); break;
      case '--id-scheme': opts.idScheme = need(i++, arg); break;
      case '--limit': opts.limit = Math.max(1, Number(need(i++, arg))); break;
      case '--report': opts.report = need(i++, arg); break;
      default: throw new Error(`Unbekannte Option: ${arg}`);
    }
  }
  if (!FILTERS[opts.filter]) {
    throw new Error(`Unbekannter Filter: ${opts.filter}. Erlaubt: ${Object.keys(FILTERS).join(', ')}`);
  }
  if (!['urn', 'media'].includes(opts.idScheme)) {
    throw new Error(`Unbekanntes id-scheme: ${opts.idScheme}. Erlaubt: urn, media`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const keep = FILTERS[opts.filter];
  const stats = {
    gelesen: 0, gefiltert: 0, abgebildet: 0, uebersprungen: 0,
    gruende: {}, felder: {}, extFacetten: {},
  };

  const input = opts.input.endsWith('.gz')
    ? createReadStream(opts.input).pipe(createGunzip())
    : createReadStream(opts.input);
  const toStdout = opts.output === '-';
  if (!toStdout) mkdirSync(dirname(opts.output), { recursive: true });
  const out = toStdout ? process.stdout : createWriteStream(opts.output);

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    stats.gelesen++;
    if (!keep(record)) { stats.gefiltert++; continue; }

    const idFor = opts.idScheme === 'media'
      ? () => record.media?.url || `urn:sodix:${record.sodixId}`
      : undefined;
    const result = sodixToAmb(record, { idFor });
    if (!result.ok) {
      stats.uebersprungen++;
      stats.gruende[result.reason] = (stats.gruende[result.reason] || 0) + 1;
      continue;
    }

    for (const key of Object.keys(result.amb)) {
      if (key === '@context') continue;
      stats.felder[key] = (stats.felder[key] || 0) + 1;
    }
    for (const facets of Object.values(result.amb.ext || {})) {
      for (const facet of Object.keys(facets)) {
        stats.extFacetten[facet] = (stats.extFacetten[facet] || 0) + 1;
      }
    }

    stats.abgebildet++;
    if (!out.write(`${JSON.stringify(result.amb)}\n`)) await once(out, 'drain');
    if (stats.abgebildet >= opts.limit) break;
  }
  rl.close();
  if (!toStdout) await new Promise((r) => out.end(r));

  const pct = (n) => (stats.abgebildet ? `${((100 * n) / stats.abgebildet).toFixed(1)}%` : '—');
  console.error(`\nFilter "${opts.filter}", id-scheme "${opts.idScheme}"`);
  console.error(`  gelesen        ${stats.gelesen}`);
  console.error(`  ausgefiltert   ${stats.gefiltert}`);
  console.error(`  abgebildet     ${stats.abgebildet}${toStdout ? '' : ` → ${opts.output}`}`);
  if (stats.uebersprungen) {
    console.error(`  uebersprungen  ${stats.uebersprungen}  ${JSON.stringify(stats.gruende)}`);
  }
  console.error('\n  AMB-Feldabdeckung:');
  for (const [k, v] of Object.entries(stats.felder).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${k.padEnd(20)} ${String(v).padStart(7)}  ${pct(v)}`);
  }
  console.error('\n  ext:de.sodix-Facetten:');
  for (const [k, v] of Object.entries(stats.extFacetten).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${k.padEnd(26)} ${String(v).padStart(7)}  ${pct(v)}`);
  }
  if (opts.report) {
    mkdirSync(dirname(opts.report), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.report, `${JSON.stringify({ ...stats, options: opts }, null, 2)}\n`);
    console.error(`\n  Bericht → ${opts.report}`);
  }
}

main().catch((err) => {
  console.error(`\nFEHLER: ${err.message}`);
  process.exit(1);
});
