#!/usr/bin/env node
/**
 * Veröffentlicht signierte Nostr-Events auf einem Relay.
 *
 * Schreibt absichtlich nur, wenn Relay UND --confirm gesetzt sind: ein
 * Nostr-Event ist über Relays repliziert und praktisch nicht zurückholbar.
 * Ohne --confirm läuft ausschliesslich die Prüfung (Trockenlauf).
 */
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

const HELP = `nostr-publish — sendet signierte kind:30142-Events an ein Relay

Aufruf:
  node bin/nostr-publish.mjs [optionen]

Optionen:
  -i, --in <datei>     events.jsonl (Default data/events.jsonl)
  --relay <url>        Ziel-Relay, z. B. wss://relay.example.org
  --confirm            tatsaechlich senden. Ohne dieses Flag nur Trockenlauf.
  --batch <n>          Events pro Fenster, Default 20
  --pause <ms>         Start-Pause zwischen Fenstern, Default 250
  --min-pause <ms>     Untergrenze beim Beschleunigen, Default 0
                       Die Pause regelt sich selbst: bei Timeouts verdoppelt sie
                       sich, nach 12 sauberen Fenstern halbiert sie sich wieder.
  --timeout <ms>       Wartezeit auf ein OK je Event, Default 30000
                       Kein OK heisst nicht abgelehnt: solche Events werden wiederholt.
  --state <datei>      Fortschritt, Default <in>.published.json
  --fresh              Fortschritt ignorieren
  -h, --help           diese Hilfe

Trockenlauf prueft jedes Event auf Signatur-Vollstaendigkeit, kind, d-Tag und
Duplikate und meldet, was gesendet WUERDE:
  node bin/nostr-publish.mjs -i data/events.jsonl

Senden (bewusst zweistufig):
  node bin/nostr-publish.mjs -i data/events.jsonl --relay wss://dein-relay --confirm
`;

function parseArgs(argv) {
  const opts = {
    input: 'data/events.jsonl', relay: null, confirm: false,
    batch: 20, pause: 250, minPause: 0, timeout: 30_000, state: null, fresh: false,
  };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} braucht einen Wert`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-h': case '--help': opts.help = true; break;
      case '-i': case '--in': opts.input = need(i++, argv[i]); break;
      case '--relay': opts.relay = need(i++, argv[i]); break;
      case '--confirm': opts.confirm = true; break;
      case '--batch': opts.batch = Math.max(1, Number(need(i++, argv[i]))); break;
      case '--pause': opts.pause = Math.max(0, Number(need(i++, argv[i]))); break;
      case '--min-pause': opts.minPause = Math.max(0, Number(need(i++, argv[i]))); break;
      case '--timeout': opts.timeout = Math.max(1000, Number(need(i++, argv[i]))); break;
      case '--state': opts.state = need(i++, argv[i]); break;
      case '--fresh': opts.fresh = true; break;
      default: throw new Error(`Unbekannte Option: ${argv[i]}`);
    }
  }
  opts.state ||= `${opts.input}.published.json`;
  return opts;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Prüft ein Event auf alles, was ein Relay ablehnen würde. */
function validate(event) {
  const problems = [];
  if (event?.kind !== 30142) problems.push(`kind ${event?.kind} statt 30142`);
  if (!HEX64.test(event?.id || '')) problems.push('id fehlt oder kein 64-Hex');
  if (!HEX64.test(event?.pubkey || '')) problems.push('pubkey fehlt oder kein 64-Hex');
  if (!HEX128.test(event?.sig || '')) problems.push('sig fehlt oder kein 128-Hex — nicht signiert?');
  if (/^0{64}$/.test(event?.pubkey || '')) problems.push('Default-Pubkey (0x00…) — ohne --nsec konvertiert');
  if (!Number.isInteger(event?.created_at)) problems.push('created_at fehlt');
  if (!Array.isArray(event?.tags)) problems.push('tags fehlen');
  else if (!event.tags.some((t) => t[0] === 'd' && t[1])) problems.push('kein d-Tag');
  return problems;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (!existsSync(opts.input)) throw new Error(`Eingabedatei fehlt: ${opts.input}`);

  const done = new Set();
  if (!opts.fresh && existsSync(opts.state)) {
    try { for (const id of JSON.parse(readFileSync(opts.state, 'utf8')).published || []) done.add(id); }
    catch { /* kaputter State ist kein Grund abzubrechen */ }
  }

  // Erst vollständig prüfen, dann senden. Ein Abbruch mitten in einem
  // halb geprüften Bestand ist schlimmer als ein paar Sekunden Vorlauf.
  const events = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;
  const rl = createInterface({ input: createReadStream(opts.input), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { invalid.push({ problems: ['kein JSON'] }); continue; }
    const problems = validate(event);
    if (problems.length) { invalid.push({ id: event.id, problems }); continue; }
    const dTag = event.tags.find((t) => t[0] === 'd')[1];
    const address = `${event.kind}:${event.pubkey}:${dTag}`;
    if (seen.has(address)) { duplicates++; continue; }
    seen.add(address);
    events.push(event);
  }

  const pending = events.filter((e) => !done.has(e.id));
  console.error(`Eingabe        ${opts.input}`);
  console.error(`  gueltig      ${events.length}`);
  if (duplicates) console.error(`  Duplikate    ${duplicates} (gleiche kind:pubkey:d-Adresse, letzte gewinnt beim Relay)`);
  if (invalid.length) {
    console.error(`  ungueltig    ${invalid.length}`);
    const byProblem = {};
    for (const item of invalid) for (const p of item.problems) byProblem[p] = (byProblem[p] || 0) + 1;
    for (const [p, n] of Object.entries(byProblem).sort((a, b) => b[1] - a[1])) {
      console.error(`     ${String(n).padStart(7)}  ${p}`);
    }
  }
  if (done.size) console.error(`  bereits sicher gesendet  ${done.size}`);
  console.error(`  offen        ${pending.length}`);

  if (!opts.relay || !opts.confirm) {
    console.error(`\nTrockenlauf — es wurde nichts gesendet.`);
    if (!opts.relay) console.error(`  Zum Senden fehlt --relay <wss://…>`);
    if (opts.relay && !opts.confirm) console.error(`  Zum Senden an ${opts.relay} fehlt --confirm`);
    process.exit(invalid.length ? 2 : 0);
  }
  if (!/^wss?:\/\//i.test(opts.relay)) throw new Error(`--relay braucht eine ws:// oder wss:// URL`);
  if (!pending.length) { console.error('\nNichts zu senden.'); return; }

  console.error(`\nSende ${pending.length} Events an ${opts.relay} …`);
  const socket = new WebSocket(opts.relay);
  const waiting = new Map();
  let accepted = 0;
  const rejected = [];
  /** Events ohne OK im Zeitfenster — werden erneut versucht, nicht verworfen. */
  let timedOut = [];
  let pause = opts.pause;
  /** Aufeinanderfolgende Fenster ohne Timeout — Grundlage fuer das Beschleunigen. */
  let cleanWindows = 0;

  socket.addEventListener('message', (msg) => {
    let frame;
    try { frame = JSON.parse(msg.data); } catch { return; }
    if (frame[0] === 'OK') {
      const [, id, ok, reason] = frame;
      const settle = waiting.get(id);
      if (settle) { waiting.delete(id); settle({ ok, reason }); }
    } else if (frame[0] === 'NOTICE') {
      console.error(`  [notice] ${frame[1]}`);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Verbindung zu ${opts.relay} fehlgeschlagen`)), { once: true });
  });

  const flush = () => {
    mkdirSync(dirname(opts.state), { recursive: true });
    writeFileSync(opts.state, `${JSON.stringify({ relay: opts.relay, published: [...done] }, null, 2)}\n`);
  };

  for (let offset = 0; offset < pending.length; offset += opts.batch) {
    const window = pending.slice(offset, offset + opts.batch);
    const results = await Promise.all(window.map((event) => {
      const settled = new Promise((resolve) => {
        waiting.set(event.id, resolve);
        setTimeout(() => {
          // Ausbleibendes OK ist KEINE Ablehnung: das Relay kann unter Last
          // langsamer antworten als das Zeitfenster erlaubt. Solche Events
          // werden wiederholt, nicht abgeschrieben — sonst zaehlt ein langsames
          // Relay als Datenfehler (gemessen: 180 vermeintliche Ablehnungen, die
          // einzeln gesendet ausnahmslos akzeptiert wurden).
          if (waiting.delete(event.id)) resolve({ timedOut: true });
        }, opts.timeout);
      });
      socket.send(JSON.stringify(['EVENT', event]));
      return settled.then((r) => ({ event, ...r }));
    }));
    for (const r of results) {
      if (r.ok) { accepted++; done.add(r.event.id); }
      else if (r.timedOut) timedOut.push(r.event);
      else rejected.push({ id: r.event.id, reason: r.reason });
    }
    flush();
    const seenSoFar = Math.min(offset + opts.batch, pending.length);
    console.error(
      `  ${seenSoFar}/${pending.length} · ${accepted} akzeptiert` +
        (rejected.length ? ` · ${rejected.length} abgelehnt` : '') +
        (timedOut.length ? ` · ${timedOut.length} ohne Antwort` : '')
    );
    // Regelkreis in beide Richtungen. Nur bremsen reicht nicht: einmal
    // langsam geworden, bliebe der Lauf für immer langsam, auch wenn das
    // Relay sich längst erholt hat. Umgekehrt darf ein Timeout nicht
    // ignoriert werden. Also: bei Timeout hart halbieren des Tempos, nach
    // mehreren sauberen Fenstern vorsichtig wieder beschleunigen. So findet
    // der Lauf die tatsaechliche Obergrenze selbst, statt sie zu raten.
    if (results.some((r) => r.timedOut)) {
      cleanWindows = 0;
      pause = Math.min(Math.max(pause, 100) * 2, 5000);
      console.error(`  Relay antwortet langsam — Pause auf ${pause} ms erhoeht`);
    } else if (++cleanWindows >= 12 && pause > opts.minPause) {
      cleanWindows = 0;
      pause = Math.max(opts.minPause, Math.floor(pause / 2));
      console.error(`  Relay kommt mit — Pause auf ${pause} ms gesenkt`);
    }
    if (pause && seenSoFar < pending.length) await sleep(pause);
  }

  // Zweiter Anlauf fuer alles ohne Antwort, einzeln und mit Ruhe. Ein
  // Duplikat ist harmlos: dieselbe id liefert erneut ein OK.
  for (let round = 1; round <= 3 && timedOut.length > 0; round++) {
    const retry = timedOut;
    timedOut = [];
    console.error(`\nWiederholung ${round}: ${retry.length} Events ohne Antwort`);
    for (const event of retry) {
      if (done.has(event.id)) continue;
      const settled = new Promise((resolve) => {
        waiting.set(event.id, resolve);
        setTimeout(() => {
          if (waiting.delete(event.id)) resolve({ timedOut: true });
        }, opts.timeout * 2);
      });
      socket.send(JSON.stringify(['EVENT', event]));
      const r = await settled;
      if (r.ok) { accepted++; done.add(event.id); }
      else if (r.timedOut) timedOut.push(event);
      else rejected.push({ id: event.id, reason: r.reason });
      await sleep(250);
    }
    flush();
    console.error(`  danach: ${accepted} akzeptiert, ${timedOut.length} weiter ohne Antwort`);
  }

  socket.close();
  flush();
  console.error(`\nakzeptiert  ${accepted}`);
  if (timedOut.length) {
    console.error(
      `ohne Antwort ${timedOut.length} — nicht bestaetigt, aber moeglicherweise gespeichert. ` +
        `Erneuter Aufruf sendet genau diese nach.`
    );
  }
  if (rejected.length) {
    console.error(`abgelehnt   ${rejected.length}`);
    const byReason = {};
    for (const r of rejected) byReason[r.reason || '(ohne Grund)'] = (byReason[r.reason || '(ohne Grund)'] || 0) + 1;
    for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.error(`   ${String(n).padStart(7)}  ${reason}`);
    }
  }
  console.error(`Fortschritt → ${opts.state}`);
  process.exit(rejected.length ? 2 : 0);
}

main().catch((err) => { console.error(`\nFEHLER: ${err.message}`); process.exit(1); });
