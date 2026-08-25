import { writeJsonAtomic, readJsonIfExists } from './writer.mjs';

/**
 * Checkpoint fuer wiederaufnehmbare Crawls.
 * Haelt fest, welche Seiten fertig geschrieben wurden, damit ein
 * abgebrochener Lauf nicht von vorn beginnen muss.
 */
export class Checkpoint {
  constructor(path) {
    this.path = path;
    const saved = readJsonIfExists(path);
    this.data = saved ?? {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      query: null,
      totalCount: null,
      donePages: [],
      records: 0,
      failedPages: [],
    };
    this.donePages = new Set(this.data.donePages || []);
    this.failedPages = new Set(this.data.failedPages || []);
    this.dirty = false;
    this.lastFlush = 0;
  }

  get records() {
    return this.data.records || 0;
  }

  isResume() {
    return this.donePages.size > 0;
  }

  /** Passt der gespeicherte Fortschritt zur aktuellen Abfrage? */
  matches(querySignature) {
    return !this.data.query || this.data.query === querySignature;
  }

  init(querySignature, totalCount) {
    this.data.query = querySignature;
    this.data.totalCount = totalCount;
    this.dirty = true;
  }

  markDone(page, recordCount) {
    this.donePages.add(page);
    this.failedPages.delete(page);
    this.data.records = (this.data.records || 0) + recordCount;
    this.dirty = true;
    this.maybeFlush();
  }

  markFailed(page, message) {
    this.failedPages.add(page);
    this.data.lastError = { page, message, at: new Date().toISOString() };
    this.dirty = true;
    this.flush();
  }

  reset() {
    this.donePages.clear();
    this.failedPages.clear();
    this.data.records = 0;
    this.data.finishedAt = null;
    this.data.startedAt = new Date().toISOString();
    this.dirty = true;
  }

  /** Haeufiges Flushen kostet I/O — hoechstens alle 2 s. */
  maybeFlush() {
    if (Date.now() - this.lastFlush > 2000) this.flush();
  }

  finish(extra = {}) {
    this.data.finishedAt = new Date().toISOString();
    Object.assign(this.data, extra);
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    this.data.donePages = [...this.donePages].sort((a, b) => a - b);
    this.data.failedPages = [...this.failedPages].sort((a, b) => a - b);
    writeJsonAtomic(this.path, this.data);
    this.dirty = false;
    this.lastFlush = Date.now();
  }
}
