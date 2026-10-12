import { describe, expect, it, vi } from 'vitest';
import type { AivenClient } from '../../src/client.js';
import { AivenError } from '../../src/errors.js';
import {
  AUTH_FAILED_MESSAGE,
  AUTH_UNAVAILABLE_MESSAGE,
  createCallerAuthorizer,
} from '../../src/marmot/authorize.js';

function clientWith(get: ReturnType<typeof vi.fn>): Pick<AivenClient, 'get'> {
  return { get } as unknown as Pick<AivenClient, 'get'>;
}

describe('createCallerAuthorizer', () => {
  it('accepts a token the Aiven API accepts', async () => {
    const get = vi.fn().mockResolvedValue({ organizations: [] });
    const authorize = createCallerAuthorizer(clientWith(get));

    await expect(authorize('token-a')).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith('/organizations', { token: 'token-a', timeout: 10_000 });
  });

  it.each([401, 403])('rejects when the Aiven API returns %i', async (status) => {
    const get = vi.fn().mockRejectedValue(new AivenError(status, 'denied'));
    const authorize = createCallerAuthorizer(clientWith(get));

    await expect(authorize('bad-token')).resolves.toEqual({
      ok: false,
      message: AUTH_FAILED_MESSAGE,
    });
  });

  it.each([
    ['a 500 response', new AivenError(500, 'boom')],
    ['a 503 response', new AivenError(503, 'down')],
    ['a network error', new TypeError('fetch failed')],
  ])('fails closed on %s', async (_label, error) => {
    const get = vi.fn().mockRejectedValue(error);
    const authorize = createCallerAuthorizer(clientWith(get));

    await expect(authorize('token-a')).resolves.toEqual({
      ok: false,
      message: AUTH_UNAVAILABLE_MESSAGE,
    });
  });

  it('caches a successful result until the TTL expires', async () => {
    let now = 0;
    const get = vi.fn().mockResolvedValue({});
    const authorize = createCallerAuthorizer(clientWith(get), { now: () => now });

    await authorize('token-a');
    now = 59_999;
    await authorize('token-a');
    expect(get).toHaveBeenCalledTimes(1);

    now = 60_001;
    await authorize('token-a');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not cache rejections', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new AivenError(401, 'denied'))
      .mockResolvedValueOnce({});
    const authorize = createCallerAuthorizer(clientWith(get));

    await expect(authorize('token-a')).resolves.toEqual({
      ok: false,
      message: AUTH_FAILED_MESSAGE,
    });
    await expect(authorize('token-a')).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('caches each token separately', async () => {
    const get = vi.fn().mockResolvedValue({});
    const authorize = createCallerAuthorizer(clientWith(get));

    await authorize('token-a');
    await authorize('token-b');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('uses the configured token when the caller has none', async () => {
    const get = vi.fn().mockResolvedValue({});
    const authorize = createCallerAuthorizer(clientWith(get));

    await expect(authorize(undefined)).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith('/organizations', { token: undefined, timeout: 10_000 });
  });
});
