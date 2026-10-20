import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_CHECK_TIMEOUT_MS, checkKey } from './key-check';

const KEY = 'AIzaSyFakeKeyForTestsOnly_0123456789abcd';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A Google-style error body: status + a google.rpc.ErrorInfo reason. */
const googleError = (code: number, status: string, reason: string, message = 'Refused.') => ({
  error: {
    code,
    message,
    status,
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' },
    ],
  },
});

const fakeFetch = (response: Response | Error) =>
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('checkKey requests', () => {
  it('lists one Gemini model with the key in a header, never in the URL', async () => {
    const fetchImpl = fakeFetch(json(200, { models: [] }));
    expect(await checkKey('gemini', KEY, fetchImpl)).toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': KEY });
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('annotates an empty batch for Vision (no image, so no unit spent)', async () => {
    const fetchImpl = fakeFetch(json(200, {}));
    expect(await checkKey('vision', KEY, fetchImpl)).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://vision.googleapis.com/v1/images:annotate');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': KEY,
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{"requests":[]}');
  });

  it('gives the request an abort signal', async () => {
    const fetchImpl = fakeFetch(json(200, {}));
    await checkKey('vision', KEY, fetchImpl);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an empty or non-ASCII key without calling Google', async () => {
    const fetchImpl = fakeFetch(json(200, {}));
    for (const key of ['', 'AIza clé', 'AIza\nabc', 'AIzaé']) {
      expect(await checkKey('gemini', key, fetchImpl)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('checkKey classification', () => {
  it.each(['gemini', 'vision'] as const)('flags a bogus %s key as invalid', async (provider) => {
    const body = googleError(
      400,
      'INVALID_ARGUMENT',
      'API_KEY_INVALID',
      'API key not valid. Please pass a valid API key.',
    );
    expect(await checkKey(provider, KEY, fakeFetch(json(400, body)))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('flags an API that is not enabled on the key project as disabled', async () => {
    const body = googleError(
      403,
      'PERMISSION_DENIED',
      'SERVICE_DISABLED',
      'Cloud Vision API has not been used in project 123 before or it is disabled.',
    );
    expect(await checkKey('vision', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('flags a key restricted to another API as disabled', async () => {
    const body = googleError(
      403,
      'PERMISSION_DENIED',
      'API_KEY_SERVICE_BLOCKED',
      'Requests to this API are blocked.',
    );
    expect(await checkKey('gemini', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('recognises a disabled API from the message when there is no reason', async () => {
    const body = {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'Generative Language API has not been used in project 1 before or it is disabled.',
      },
    };
    expect(await checkKey('gemini', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('flags a project without billing as billing', async () => {
    const body = googleError(
      403,
      'PERMISSION_DENIED',
      'BILLING_DISABLED',
      'This API method requires billing to be enabled.',
    );
    expect(await checkKey('vision', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'billing',
    });
  });

  it('flags a 429 as quota', async () => {
    expect(
      await checkKey(
        'gemini',
        KEY,
        fakeFetch(json(429, googleError(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'))),
      ),
    ).toEqual({ ok: false, reason: 'quota' });
    expect(await checkKey('gemini', KEY, fakeFetch(json(429, 'not json')))).toEqual({
      ok: false,
      reason: 'quota',
    });
  });

  it('flags RESOURCE_EXHAUSTED as quota whatever the HTTP status', async () => {
    const body = { error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } };
    expect(await checkKey('vision', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'quota',
    });
  });

  it('calls any other refusal invalid, even without a readable body', async () => {
    expect(
      await checkKey('gemini', KEY, fakeFetch(new Response('<html>', { status: 403 }))),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await checkKey('vision', KEY, fakeFetch(new Response('', { status: 500 })))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(
      await checkKey('vision', KEY, fakeFetch(json(404, { error: { message: 'Not found' } }))),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reads the legacy errors[].reason shape too', async () => {
    const body = {
      error: { code: 403, message: 'Not configured', errors: [{ reason: 'accessNotConfigured' }] },
    };
    expect(await checkKey('vision', KEY, fakeFetch(json(403, body)))).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });
});

describe('checkKey network failures', () => {
  it('reports a thrown fetch as a network failure', async () => {
    expect(await checkKey('gemini', KEY, fakeFetch(new TypeError('Failed to fetch')))).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('gives up after 10 seconds', async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const result = checkKey('vision', KEY, hanging);
    await vi.advanceTimersByTimeAsync(KEY_CHECK_TIMEOUT_MS - 1);
    expect(hanging.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: false, reason: 'network' });
  });

  it('keeps the timeout running while the error body is read', async () => {
    vi.useFakeTimers();
    const slowBody = vi.fn((_url: string, init: RequestInit) => {
      const response = new Response(null, { status: 403 });
      vi.spyOn(response, 'text').mockImplementation(
        () =>
          new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      return Promise.resolve(response);
    });
    const result = checkKey('gemini', KEY, slowBody);
    await vi.advanceTimersByTimeAsync(KEY_CHECK_TIMEOUT_MS);
    expect(await result).toEqual({ ok: false, reason: 'network' });
  });
});
