import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPrompt, SUMMARY_MAX_CHARS, type ReviewInput } from '../../lib/google/gemini';
import {
  CLAUDE_IMAGE_MAX_BASE64_CHARS,
  CLAUDE_REVIEW_MODEL,
  CLAUDE_TIMEOUT_MS,
  reviewWithClaude,
  type ClaudeDeps,
} from './claude';

/**
 * Through the real SDK (its client, its typed errors, its request building), with only `fetch`
 * replaced by a fake that answers like the Anthropic API.
 */

const KEY = 'sk-ant-api03-test-key-0001';
const INPUT: ReviewInput = {
  photo: { mimeType: 'image/jpeg', base64: '/9j/4AAQSkZJRg==' },
  title: 'Robe fleurie',
  description: 'Jamais portée',
  price: '12,00 €',
  signals: ["Recherche d'image : la même photo est en vente sur Shein."],
};
const REVIEW = { catalogPhoto: true, summary: 'La même photo est en vente sur Shein.' };

type FetchCall = [string | URL | Request, RequestInit | undefined];

/** A message as the API sends it back, `text` being the model's structured answer. */
function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: CLAUDE_REVIEW_MODEL,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 80 },
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An error body as the API sends it. */
const apiError = (status: number, type: string, text: string) =>
  json({ type: 'error', error: { type, message: text } }, status);

function fakeFetch(answer: () => Response | Promise<Response>) {
  return vi.fn<NonNullable<ClaudeDeps['fetch']>>(async () => answer());
}

/** The JSON body of the first request the fake saw. */
function sentBody(fetchImpl: ReturnType<typeof fakeFetch>): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[0] as FetchCall;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reviewWithClaude request', () => {
  it('posts to the Messages API with the key in a header (the SDK picks which), retrying nothing', async () => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as FetchCall;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect([...headers.values()].some((value) => value.includes(KEY))).toBe(true);
    expect(headers.get('content-type')).toContain('application/json');
    // The key is nowhere else: not in the address, not in the body.
    expect(String(url)).not.toContain(KEY);
    expect(String(init?.body)).not.toContain(KEY);
  });

  it('asks Claude Haiku 5.5 for a structured answer at the lowest effort, the photo first', async () => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    const body = sentBody(fetchImpl);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(CLAUDE_REVIEW_MODEL).toBe('claude-haiku-5-5');
    expect(body.output_config).toEqual({
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { catalogPhoto: { type: 'boolean' }, summary: { type: 'string' } },
          required: ['catalogPhoto', 'summary'],
          additionalProperties: false,
        },
      },
    });
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: INPUT.photo.base64 },
          },
          // The extension's own prompt, quoting rules against forged seller text included.
          { type: 'text', text: buildPrompt(INPUT) },
        ],
      },
    ]);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBeGreaterThan(1_000);
  });

  it('sends nothing that Claude Haiku 5.5 refuses: no sampling parameter, no thinking budget, no prefill', async () => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    const body = sentBody(fetchImpl);
    for (const name of ['temperature', 'top_p', 'top_k', 'thinking', 'budget_tokens', 'system']) {
      expect(body, name).not.toHaveProperty(name);
    }
    // The conversation ends on the user's turn (an assistant prefill is a 400).
    expect((body.messages as Array<{ role: string }>).at(-1)?.role).toBe('user');
  });

  it.each(['image/png', 'image/gif', 'image/webp'])(
    'announces a %s photo as it is',
    async (type) => {
      const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
      await reviewWithClaude({ ...INPUT, photo: { ...INPUT.photo, mimeType: type } }, KEY, {
        fetch: fetchImpl,
      });

      const content = (sentBody(fetchImpl).messages as Array<{ content: unknown[] }>)[0]?.content;
      expect(content?.[0]).toMatchObject({ source: { media_type: type } });
    },
  );

  it('lets the whole exchange be aborted: the call carries a signal', async () => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as FetchCall;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('reviewWithClaude answer', () => {
  it('reads the review from the structured answer', async () => {
    const result = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => json(message(JSON.stringify(REVIEW)))),
    });
    expect(result).toEqual({ ok: true, review: REVIEW });
  });

  it('skips the thinking blocks and joins the text ones', async () => {
    const answer = message('', {
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '{"catalogPhoto":false,' },
        { type: 'text', text: '"summary":"Photo prise à la maison."}' },
      ],
    });
    const result = await reviewWithClaude(INPUT, KEY, { fetch: fakeFetch(() => json(answer)) });
    expect(result).toEqual({
      ok: true,
      review: { catalogPhoto: false, summary: 'Photo prise à la maison.' },
    });
  });

  it('strips the HTML of the summary (the card shows plain text)', async () => {
    const result = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() =>
        json(message(JSON.stringify({ catalogPhoto: false, summary: 'Une <b>jolie</b> robe.' }))),
      ),
    });
    expect(result).toEqual({
      ok: true,
      review: { catalogPhoto: false, summary: 'Une jolie robe.' },
    });
  });

  it.each([
    ['text that is not JSON', 'Voici mon avis : la photo vient de Shein.'],
    ['a JSON fence', '```json\n{"catalogPhoto":true,"summary":"ok"}\n```'],
    ['no text at all', ''],
    ['a non-boolean catalogPhoto', '{"catalogPhoto":"yes","summary":"ok"}'],
    ['a missing summary', '{"catalogPhoto":true}'],
    ['an empty summary', '{"catalogPhoto":true,"summary":"  "}'],
    ['a summary that is not text', '{"catalogPhoto":true,"summary":12}'],
    [
      'a summary too long to be one',
      JSON.stringify({ catalogPhoto: true, summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) }),
    ],
    ['an array', '[{"catalogPhoto":true,"summary":"ok"}]'],
  ])('refuses %s: processed and billed, so not refundable', async (_what, text) => {
    const result = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => json(message(text))),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_answer', refundable: false });
  });

  it.each(['refusal', 'max_tokens'])(
    'refuses a %s stop even when the text looks right: invalid_answer, not refundable',
    async (stopReason) => {
      const result = await reviewWithClaude(INPUT, KEY, {
        fetch: fakeFetch(() => json(message(JSON.stringify(REVIEW), { stop_reason: stopReason }))),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_answer', refundable: false });
    },
  );

  it('refuses an answer with no content: invalid_answer', async () => {
    const result = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => json(message('', { content: [] }))),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_answer', refundable: false });
  });
});

describe('reviewWithClaude errors', () => {
  const CREDIT =
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

  // [status, API error type, message, failure]: the refund rule is "only when certainly not billed".
  const cases: Array<[number, string, string, Record<string, unknown>]> = [
    [401, 'authentication_error', 'invalid x-api-key', { reason: 'invalid', refundable: true }],
    [403, 'permission_error', 'Not allowed', { reason: 'invalid', refundable: true }],
    [
      429,
      'rate_limit_error',
      'Number of request tokens exceeded',
      { reason: 'quota', refundable: true },
    ],
    [400, 'invalid_request_error', CREDIT, { reason: 'billing', refundable: true }],
    [
      400,
      'invalid_request_error',
      'messages.0.content.0.image: Image does not match the provided media type',
      { reason: 'unavailable', specific: true, refundable: true },
    ],
    [402, 'billing_error', 'Billing problem', { reason: 'billing', refundable: true }],
    [
      404,
      'not_found_error',
      'model: claude-haiku-5-5',
      { reason: 'unavailable', refundable: true },
    ],
    [
      413,
      'request_too_large',
      'Request exceeds the maximum size',
      { reason: 'photo', refundable: true },
    ],
    [529, 'overloaded_error', 'Overloaded', { reason: 'network', refundable: false }],
    [500, 'api_error', 'Internal server error', { reason: 'network', refundable: false }],
    [503, 'api_error', 'Service unavailable', { reason: 'network', refundable: false }],
    [422, 'invalid_request_error', 'Unprocessable', { reason: 'unavailable', refundable: false }],
  ];

  it.each(cases)('reads a %i %s as a failure', async (status, type, text, failure) => {
    const fetchImpl = fakeFetch(() => apiError(status, type, text));
    const result = await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    expect(result).toEqual({ ok: false, ...failure });
    // No retry: a second call would be a second bill.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the 400 of an empty credit balance apart from any other 400 (the message decides)', async () => {
    const low = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => apiError(400, 'invalid_request_error', CREDIT)),
    });
    const other = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => apiError(400, 'invalid_request_error', 'max_tokens: too large')),
    });
    expect(low).toMatchObject({ reason: 'billing' });
    expect(other).toMatchObject({ reason: 'unavailable', specific: true });
  });

  it('logs a refused request by its error type only, never the key nor the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => apiError(400, 'invalid_request_error', 'max_tokens: too large')),
    });
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toBe('[claude] request refused (400 invalid_request_error)');
    warn.mockRestore();
  });

  it('reads a refusal with no readable body by its status', async () => {
    const result = await reviewWithClaude(INPUT, KEY, {
      fetch: fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 })),
    });
    expect(result).toEqual({ ok: false, reason: 'network', refundable: false });
  });

  it('reads a failed connection as a network failure that may have been billed', async () => {
    const fetchImpl = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const result = await reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });

    expect(result).toEqual({ ok: false, reason: 'network', refundable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout: a network failure, not refundable', async () => {
    vi.useFakeTimers();
    // A server that never answers: the request ends when the SDK aborts it.
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );

    const pending = reviewWithClaude(INPUT, KEY, { fetch: fetchImpl });
    await vi.advanceTimersByTimeAsync(CLAUDE_TIMEOUT_MS + 1);

    expect(await pending).toEqual({ ok: false, reason: 'network', refundable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never returns or logs the key, nor anything the API said', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const [status, type, text] of cases) {
      const result = await reviewWithClaude(INPUT, KEY, {
        fetch: fakeFetch(() => apiError(status, type, `${text} (${KEY})`)),
      });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain(text);
    }
    expect(log).not.toHaveBeenCalled();
    // A refused 400 is logged by its error type only (no alert would say it otherwise).
    for (const call of warn.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).not.toContain(KEY);
      for (const [, , text] of cases) expect(line).not.toContain(text);
    }
    vi.restoreAllMocks();
  });
});

describe('reviewWithClaude, requests that are never sent', () => {
  it.each([
    ['a type Claude does not read (HEIC)', 'image/heic', INPUT.photo.base64],
    ['a type that is not an image', 'text/html', INPUT.photo.base64],
    ['an image over 5 MB of base64', 'image/jpeg', 'A'.repeat(CLAUDE_IMAGE_MAX_BASE64_CHARS + 1)],
  ])('does not send %s: photo, refundable', async (_what, mimeType, base64) => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    const result = await reviewWithClaude({ ...INPUT, photo: { mimeType, base64 } }, KEY, {
      fetch: fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: 'photo', refundable: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends an image of exactly 5 MB of base64', async () => {
    const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
    const photo = { mimeType: 'image/jpeg', base64: 'A'.repeat(CLAUDE_IMAGE_MAX_BASE64_CHARS) };
    const result = await reviewWithClaude({ ...INPUT, photo }, KEY, { fetch: fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'sk-ant\n-key', 'sk-ant-clé'])(
    'does not send a key that cannot be a header (%j): invalid, refundable',
    async (key) => {
      const fetchImpl = fakeFetch(() => json(message(JSON.stringify(REVIEW))));
      const result = await reviewWithClaude(INPUT, key, { fetch: fetchImpl });

      expect(result).toEqual({ ok: false, reason: 'invalid', refundable: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
