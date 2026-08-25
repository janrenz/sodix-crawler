import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimaler .env-Loader (keine Abhaengigkeiten). */
function loadDotEnv(file = '.env') {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv();

export const config = {
  apiUrl: (process.env.SODIX_API_URL || 'https://api3.sodix.de').replace(/\/+$/, ''),
  username: process.env.SODIX_USERNAME || '',
  password: process.env.SODIX_PASSWORD || '',
  pageSize: Number(process.env.SODIX_PAGE_SIZE || 100),
  concurrency: Number(process.env.SODIX_CONCURRENCY || 4),
  outDir: process.env.SODIX_OUT_DIR || './data',
  requestTimeoutMs: Number(process.env.SODIX_TIMEOUT_MS || 120_000),
  maxRetries: Number(process.env.SODIX_MAX_RETRIES || 5),
};

export function assertCredentials() {
  if (!config.username || !config.password) {
    throw new Error(
      'SODIX_USERNAME und SODIX_PASSWORD fehlen. Lege eine .env an (siehe .env.example).'
    );
  }
}

export const graphqlEndpoint = () => `${config.apiUrl}/graphql`;
