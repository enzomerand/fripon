import { afterEach, describe, expect, it, vi } from 'vitest';
import { VISION_MAX_RESULTS, VISION_TIMEOUT_MS, VISION_URL, webDetect } from './vision';

const KEY = 'AIzaSyFakeKeyForTestsOnly_0123456789abcd';
const IMAGE = 'QUJDREVGRw==';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A Google-style HTTP error body: status + a google.rpc.ErrorInfo reason. */
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

/** A 200 answer holding one per-image response. */
const answer = (first: unknown) => json(200, { responses: [first] });

afterEach(() => {
  vi.useRealTimers();
});

describe('webDetect request', () => {
  it('posts one image with the WEB_DETECTION feature and the key in a header only', async () => {
    const fetchImpl = fakeFetch(answer({ webDetection: {} }));
    expect(await webDetect(IMAGE, KEY, fetchImpl)).toEqual({ ok: true, webDetection: {} });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VISION_URL);
    expect(url).toBe('https://vision.googleapis.com/v1/images:annotate');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-goog-api-key': KEY, 'content-type': 'application/json' });
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [
        {
          image: { content: IMAGE },
          features: [{ type: 'WEB_DETECTION', maxResults: VISION_MAX_RESULTS }],
        },
      ],
    });
    expect(url).not.toContain(KEY);
    expect(init.body).not.toContain(KEY);
  });

  it('refuses a key that cannot be sent as a header, without calling Google', async () => {
    const fetchImpl = fakeFetch(answer({}));
    expect(await webDetect(IMAGE, 'AIza clé', fetchImpl)).toEqual({ ok: false, reason: 'invalid' });
    expect(await webDetect(IMAGE, '', fetchImpl)).toEqual({ ok: false, reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('webDetect answer', () => {
  it('keeps the pages with their title and matching images, and drops the rest', async () => {
    const fetchImpl = fakeFetch(
      answer({
        webDetection: {
          webEntities: [{ entityId: '/m/x', score: 1, description: 'Dress' }],
          bestGuessLabels: [{ label: 'dress' }],
          fullMatchingImages: [{ url: 'https://img.example/full.jpg' }],
          pagesWithMatchingImages: [
            {
              url: 'https://fr.shein.example/robe-p-1.html',
              pageTitle: 'Robe <b>fleurie</b>',
              fullMatchingImages: [{ url: 'https://img.example/a.jpg' }],
              unexpected: 'dropped',
            },
            { url: 'https://example.test/other', partialMatchingImages: [{ url: 'https://i/p' }] },
          ],
        },
      }),
    );
    const result = await webDetect(IMAGE, KEY, fetchImpl);
    expect(result).toEqual({
      ok: true,
      webDetection: {
        fullMatchingImages: [{ url: 'https://img.example/full.jpg' }],
        pagesWithMatchingImages: [
          {
            url: 'https://fr.shein.example/robe-p-1.html',
            pageTitle: 'Robe <b>fleurie</b>',
            fullMatchingImages: [{ url: 'https://img.example/a.jpg' }],
          },
          { url: 'https://example.test/other', partialMatchingImages: [{ url: 'https://i/p' }] },
        ],
      },
    });
  });

  it('gives an empty detection for a photo found nowhere', async () => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(answer({})))).toEqual({
      ok: true,
      webDetection: {},
    });
  });

  it('ignores malformed pieces instead of throwing', async () => {
    const fetchImpl = fakeFetch(
      answer({
        webDetection: {
          pagesWithMatchingImages: [
            null,
            'x',
            { url: 12, pageTitle: [] },
            { url: 'https://a.test/' },
          ],
          fullMatchingImages: 'nope',
        },
      }),
    );
    expect(await webDetect(IMAGE, KEY, fetchImpl)).toEqual({
      ok: true,
      webDetection: { pagesWithMatchingImages: [{}, { url: 'https://a.test/' }] },
    });
  });

  it.each([
    ['no responses array', json(200, {})],
    ['an empty responses array', json(200, { responses: [] })],
    ['a non-object response', json(200, { responses: [null] })],
    ['a body that is not JSON', new Response('<html>', { status: 200 })],
  ])('counts %s as a failed attempt', async (_name, response) => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(response))).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('webDetect HTTP failures', () => {
  const cases: Array<[string, number, unknown, string]> = [
    ['a bogus key', 400, googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'invalid'],
    [
      'a project without the API',
      403,
      googleError(403, 'PERMISSION_DENIED', 'SERVICE_DISABLED'),
      'disabled',
    ],
    [
      'a key restricted to other APIs',
      403,
      googleError(403, 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED'),
      'restricted',
    ],
    [
      'a project without billing',
      403,
      googleError(
        403,
        'PERMISSION_DENIED',
        'UNKNOWN',
        'This API method requires billing to be enabled.',
      ),
      'billing',
    ],
    [
      'an exhausted quota',
      429,
      googleError(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'),
      'quota',
    ],
    ['an unreadable refusal', 403, 'not json', 'invalid'],
  ];

  it.each(cases)('maps %s to its reason', async (_name, status, body, reason) => {
    const response = typeof body === 'string' ? new Response(body, { status }) : json(status, body);
    expect(await webDetect(IMAGE, KEY, fakeFetch(response))).toEqual({ ok: false, reason });
  });

  it('counts a Google server error as a network failure', async () => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(json(503, {})))).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('counts a failed request as a network failure', async () => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(new TypeError('Failed to fetch')))).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('webDetect per-image errors', () => {
  it('counts an error on the image as a failure, never as "nothing found"', async () => {
    const result = await webDetect(
      IMAGE,
      KEY,
      fakeFetch(answer({ error: { code: 3, message: 'Bad image data.' } })),
    );
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('keeps the reason Google names on the image', async () => {
    const withReason = (reason: string, message = 'x') => ({
      error: {
        code: 7,
        message,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
      },
    });
    const reasonOf = async (first: unknown) => {
      const result = await webDetect(IMAGE, KEY, fakeFetch(answer(first)));
      return result.ok ? 'ok' : result.reason;
    };
    expect(await reasonOf(withReason('BILLING_DISABLED'))).toBe('billing');
    expect(await reasonOf(withReason('SERVICE_DISABLED'))).toBe('disabled');
    expect(await reasonOf(withReason('API_KEY_SERVICE_BLOCKED'))).toBe('restricted');
    expect(await reasonOf({ error: { code: 8, message: 'Quota exceeded.' } })).toBe('quota');
  });

  it('treats a permission or authentication error without detail as a refused key', async () => {
    for (const code of [7, 16]) {
      expect(
        await webDetect(IMAGE, KEY, fakeFetch(answer({ error: { code, message: 'no' } }))),
      ).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('webDetect timeout', () => {
  it('gives up after 20 seconds, answer body included', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        }),
    );
    const pending = webDetect(IMAGE, KEY, fetchImpl);
    await vi.advanceTimersByTimeAsync(VISION_TIMEOUT_MS - 1);
    expect(fetchImpl.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: 'network' });
    expect(VISION_TIMEOUT_MS).toBe(20_000);
  });
});
