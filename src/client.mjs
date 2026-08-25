import { config, graphqlEndpoint, assertCredentials } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GraphQLError extends Error {
  constructor(errors, query) {
    super(errors.map((e) => e.message).join(' | '));
    this.name = 'GraphQLError';
    this.errors = errors;
    this.query = query;
  }
}

/**
 * GraphQL-Client fuer die SODIX API v3.
 * Uebernimmt Login, proaktive Token-Erneuerung, Retries mit Backoff
 * und Begrenzung paralleler Requests.
 */
export class SodixClient {
  constructor({ concurrency = config.concurrency, verbose = true } = {}) {
    this.token = null;
    this.tokenExpiresAt = 0;
    this.loginPromise = null;
    this.verbose = verbose;
    this.maxInFlight = Math.max(1, concurrency);
    this.inFlight = 0;
    this.queue = [];
    this.stats = { requests: 0, retries: 0, logins: 0, bytes: 0 };
  }

  log(...args) {
    if (this.verbose) console.error(...args);
  }

  /** Login; laeuft nur einmal parallel, weitere Aufrufer warten mit. */
  async login(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.loginPromise) return this.loginPromise;

    assertCredentials();
    this.loginPromise = (async () => {
      const query = `query Auth($login: String!, $password: String!) {
  auth {
    login(loginInput: { login: $login, password: $password }) {
      accessToken
      refreshToken
      expiresIn
      error
    }
  }
}`;
      // Bewusst ohne this.request(): sonst Endlosschleife ueber ensureToken().
      const body = await this.rawRequest(
        { query, variables: { login: config.username, password: config.password } },
        { auth: false }
      );
      const res = body?.data?.auth?.login;
      if (!res?.accessToken) {
        throw new Error(`Login fehlgeschlagen: ${res?.error ?? 'keine Antwort vom Server'}`);
      }
      this.token = res.accessToken;
      // 60 s Sicherheitspuffer vor dem echten Ablauf.
      const ttl = Number(res.expiresIn || 28_799);
      this.tokenExpiresAt = Date.now() + Math.max(60, ttl - 60) * 1000;
      this.stats.logins++;
      this.log(`[auth] eingeloggt als ${config.username}, Token gueltig ${Math.round(ttl / 60)} min`);
      return this.token;
    })().finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  async ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.login(true);
    return this.token;
  }

  /** Ein einzelner HTTP-Request ohne Retry-Logik. */
  async rawRequest(payload, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.ensureToken()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response;
    try {
      response = await fetch(graphqlEndpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    this.stats.requests++;
    this.stats.bytes += text.length;

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
      err.status = response.status;
      throw err;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const err = new Error(`Antwort ist kein JSON: ${text.slice(0, 200)}`);
      err.status = response.status;
      throw err;
    }
    return json;
  }

  /** Entscheidet, ob ein Fehler einen erneuten Versuch wert ist. */
  static isRetryable(err) {
    if (err.name === 'AbortError') return true;
    if (err.status && [408, 425, 429, 500, 502, 503, 504].includes(err.status)) return true;
    if (err.name === 'GraphQLError') {
      return err.errors.some((e) => {
        const msg = e.message || '';
        // "Exception while fetching data (/metadata/search) : null" ist der
        // Standard-Wrapper der SODIX-API fuer serverseitige Aussetzer unter
        // Last. Transient: derselbe Request klappt beim naechsten Versuch.
        // Ohne diesen Fall brechen unter Last ganze Seiten weg (gemessen:
        // 174 von 2.159 Seiten in einem Vollabzug).
        if (/Exception while fetching data/i.test(msg)) return true;
        return /timeout|timed out|too many|rate limit|internal|temporar|connection|unavailable/i.test(msg);
      });
    }
    // Netzwerk-/DNS-/Socket-Fehler
    return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|terminated/i.test(
      String(err.message)
    );
  }

  /** GraphQL-Request mit Concurrency-Limit, Retries und Token-Erneuerung. */
  async request(query, variables = {}, { label = 'query', maxRetries = config.maxRetries } = {}) {
    await this.acquire();
    try {
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const json = await this.rawRequest({ query, variables });
          if (json.errors?.length) {
            const unauthorized = json.errors.some((e) =>
              /unauthorized|unauthenticated|token|forbidden|jwt/i.test(e.message || '')
            );
            if (unauthorized && attempt < maxRetries) {
              this.log(`[auth] Token abgelehnt (${label}), neuer Login`);
              await this.login(true);
              this.stats.retries++;
              continue;
            }
            throw new GraphQLError(json.errors, query);
          }
          return json.data;
        } catch (err) {
          lastErr = err;
          if (err.status === 401 || err.status === 403) {
            await this.login(true);
            this.stats.retries++;
            continue;
          }
          if (attempt >= maxRetries || !SodixClient.isRetryable(err)) throw err;
          const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
          this.stats.retries++;
          this.log(
            `[retry] ${label}: ${String(err.message).slice(0, 140)} — neuer Versuch in ${backoff} ms (${attempt + 1}/${maxRetries})`
          );
          await sleep(backoff);
        }
      }
      throw lastErr;
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.inFlight--;
  }
}
