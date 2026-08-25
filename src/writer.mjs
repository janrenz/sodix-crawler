import { createWriteStream, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

/**
 * Append-Writer fuer NDJSON (optional gzip).
 * Ein Datensatz pro Zeile — robust gegen Abbrueche und streambar auswertbar.
 */
export class NdjsonWriter {
  constructor(path, { gzip = false, append = false } = {}) {
    this.path = gzip && !path.endsWith('.gz') ? `${path}.gz` : path;
    mkdirSync(dirname(this.path), { recursive: true });
    // Bei gzip ist Append nur als eigenes gzip-Member moeglich; das lesen
    // gzip/zcat korrekt, darum ist Anhaengen auch hier unproblematisch.
    this.out = createWriteStream(this.path, { flags: append ? 'a' : 'w' });
    if (gzip) {
      this.gz = createGzip({ level: 6 });
      this.gz.pipe(this.out);
      this.sink = this.gz;
    } else {
      this.sink = this.out;
    }
    this.count = 0;
  }

  /** Schreibt einen Datensatz; wartet bei voller Pipe auf 'drain'. */
  async write(record) {
    this.count++;
    if (!this.sink.write(`${JSON.stringify(record)}\n`)) {
      await once(this.sink, 'drain');
    }
  }

  async writeAll(records) {
    for (const record of records) await this.write(record);
  }

  async close() {
    await new Promise((resolve, reject) => {
      this.sink.once('error', reject);
      this.out.once('error', reject);
      this.out.once('close', resolve);
      this.sink.end();
    });
    return { path: this.path, count: this.count };
  }
}

/** Schreibt JSON atomar (erst .tmp, dann rename) — kein halbes File bei Ctrl-C. */
export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJsonIfExists(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export const runPath = (outDir, ...parts) => join(outDir, ...parts);
