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

  it('refuses a key that cannot be sent as a header, without calling Google, so nothing is billed', async () => {
    const fetchImpl = fakeFetch(answer({}));
    const refused = { ok: false, reason: 'invalid', refundable: true };
    expect(await webDetect(IMAGE, 'AIza clé', fetchImpl)).toEqual(refused);
    expect(await webDetect(IMAGE, '', fetchImpl)).toEqual(refused);
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
  ])('counts %s as a failed attempt that may have been billed', async (_name, response) => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(response))).toEqual({
      ok: false,
      reason: 'network',
      refundable: false,
    });
  });
});

describe('webDetect HTTP refusals Google names', () => {
  // 400, 403 and 429 with a refusal Google names: the call certainly was not billed.
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
      'a project without billing (reason)',
      403,
      googleError(403, 'PERMISSION_DENIED', 'BILLING_DISABLED'),
      'billing',
    ],
    [
      'a project without billing (message)',
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
  ];

  it.each(cases)(
    'maps %s to its reason and allows a refund',
    async (_name, status, body, reason) => {
      expect(await webDetect(IMAGE, KEY, fakeFetch(json(status, body)))).toEqual({
        ok: false,
        reason,
        refundable: true,
      });
    },
  );

  it('allows a refund on a 429 even when the body cannot be read', async () => {
    expect(
      await webDetect(IMAGE, KEY, fakeFetch(new Response('slow down', { status: 429 }))),
    ).toEqual({
      ok: false,
      reason: 'quota',
      refundable: true,
    });
  });
});

describe('webDetect refusals that may have been billed', () => {
  it.each([
    [
      'a 400 with no reason Google names',
      400,
      googleError(400, 'INVALID_ARGUMENT', 'OTHER'),
      'photo',
    ],
    ['a 400 with an unreadable body', 400, 'not json', 'photo'],
    ['a payload too large', 413, 'too big', 'photo'],
    [
      'a 403 with no reason Google names',
      403,
      googleError(403, 'PERMISSION_DENIED', 'OTHER'),
      'invalid',
    ],
    ['an unreadable 403', 403, 'not json', 'invalid'],
    ['a 401', 401, googleError(401, 'UNAUTHENTICATED', 'OTHER'), 'invalid'],
    [
      'a named refusal on a status that is not 400, 403 or 429',
      401,
      googleError(401, 'UNAUTHENTICATED', 'API_KEY_INVALID'),
      'invalid',
    ],
  ])('keeps the credit on %s', async (_name, status, body, reason) => {
    const response = typeof body === 'string' ? new Response(body, { status }) : json(status, body);
    expect(await webDetect(IMAGE, KEY, fakeFetch(response))).toEqual({
      ok: false,
      reason,
      refundable: false,
    });
  });

  it('keeps the credit on a Google server error', async () => {
    for (const status of [500, 502, 503]) {
      expect(await webDetect(IMAGE, KEY, fakeFetch(json(status, {})))).toEqual({
        ok: false,
        reason: 'network',
        refundable: false,
      });
    }
  });

  it('keeps the credit when the request fails before any answer (it may have been received)', async () => {
    expect(await webDetect(IMAGE, KEY, fakeFetch(new TypeError('Failed to fetch')))).toEqual({
      ok: false,
      reason: 'network',
      refundable: false,
    });
  });

  it('keeps the credit when the body of a refusal cannot be read to the end', async () => {
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 403 },
    );
    expect(await webDetect(IMAGE, KEY, fakeFetch(broken))).toEqual({
      ok: false,
      reason: 'network',
      refundable: false,
    });
  });
});

describe('webDetect per-image errors', () => {
  const reasonOf = async (first: unknown) => {
    const result = await webDetect(IMAGE, KEY, fakeFetch(answer(first)));
    return result.ok ? 'ok' : result;
  };
  const withReason = (reason: string, code = 7, message = 'x') => ({
    error: {
      code,
      message,
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
    },
  });

  it('blames the photo for bad image data, never "nothing found"', async () => {
    expect(await reasonOf({ error: { code: 3, message: 'Bad image data.' } })).toEqual({
      ok: false,
      reason: 'photo',
      refundable: false,
    });
    expect(await reasonOf({ error: { code: 0, message: 'bad image data' } })).toMatchObject({
      reason: 'photo',
    });
  });

  it('keeps the reason Google names on the image, and never allows a refund', async () => {
    const expected: Array<[unknown, string]> = [
      [withReason('BILLING_DISABLED'), 'billing'],
      [withReason('SERVICE_DISABLED'), 'disabled'],
      [withReason('API_KEY_SERVICE_BLOCKED'), 'restricted'],
      [withReason('API_KEY_INVALID', 3), 'invalid'],
      [{ error: { code: 8, message: 'Quota exceeded.' } }, 'quota'],
    ];
    for (const [first, reason] of expected) {
      expect(await reasonOf(first)).toEqual({ ok: false, reason, refundable: false });
    }
  });

  it('treats a permission or authentication error without detail as a refused key', async () => {
    for (const code of [7, 16]) {
      expect(await reasonOf({ error: { code, message: 'no' } })).toEqual({
        ok: false,
        reason: 'invalid',
        refundable: false,
      });
    }
  });

  it('reads any other error on the image as a failed attempt', async () => {
    for (const code of [4, 13, 14]) {
      expect(await reasonOf({ error: { code, message: 'Unavailable.' } })).toEqual({
        ok: false,
        reason: 'network',
        refundable: false,
      });
    }
  });
});

describe('webDetect timeout', () => {
  it('gives up after 20 seconds, answer body included, and keeps the credit', async () => {
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
    expect(await pending).toEqual({ ok: false, reason: 'network', refundable: false });
    expect(VISION_TIMEOUT_MS).toBe(20_000);
  });
});
