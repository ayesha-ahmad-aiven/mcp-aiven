import { createHash } from 'node:crypto';
import type { AivenClient } from '../client.js';
import { AivenError } from '../errors.js';

const DEFAULT_CACHE_TTL_MS = 60_000;
const AUTHORIZATION_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 1_000;
const CONFIGURED_TOKEN_KEY = 'configured-token';

export const AUTH_FAILED_MESSAGE =
  'Aiven authentication failed. Marmot data catalog tools require a valid Aiven token.';
export const AUTH_UNAVAILABLE_MESSAGE =
  'Could not verify Aiven authentication because the Aiven API is unavailable. Try again later.';

export type CallerAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };
export type CallerAuthorizer = (token: string | undefined) => Promise<CallerAuthorization>;

export interface CallerAuthorizerOptions {
  cacheTtlMs?: number | undefined;
  now?: (() => number) | undefined;
}

export function createCallerAuthorizer(
  client: Pick<AivenClient, 'get'>,
  options: CallerAuthorizerOptions = {}
): CallerAuthorizer {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const validUntil = new Map<string, number>();

  function remember(key: string): void {
    if (validUntil.size >= MAX_CACHE_ENTRIES) {
      for (const [cachedKey, expiry] of validUntil) {
        if (expiry <= now()) validUntil.delete(cachedKey);
      }
    }
    validUntil.set(key, now() + cacheTtlMs);
  }

  return async (token) => {
    const key =
      token === undefined ? CONFIGURED_TOKEN_KEY : createHash('sha256').update(token).digest('hex');
    const expiry = validUntil.get(key);
    if (expiry !== undefined && expiry > now()) return { ok: true };

    try {
      await client.get('/organizations', { token, timeout: AUTHORIZATION_TIMEOUT_MS });
    } catch (error) {
      validUntil.delete(key);
      const rejected =
        error instanceof AivenError && (error.status === 401 || error.status === 403);
      return { ok: false, message: rejected ? AUTH_FAILED_MESSAGE : AUTH_UNAVAILABLE_MESSAGE };
    }

    remember(key);
    return { ok: true };
  };
}
