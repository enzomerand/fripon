import { describe, expect, it, vi } from 'vitest';
import { GEMINI_MODEL, GEMINI_URL, type ReviewInput } from '../../lib/google/gemini';
import { CLAUDE_REVIEW_MODEL } from './claude';
import { isOwnerProblem, realReviewer, upstreamReason } from './google';

const INPUT: ReviewInput = {
  photo: { mimeType: 'image/jpeg', base64: '/9j/4AAQ' },
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: [],
};
const REVIEW = { catalogPhoto: true, summary: 'La même photo est en vente sur Shein.' };
const GEMINI_KEY = 'AIza-test-gemini-key-0002';
const ANTHROPIC_KEY = 'sk-ant-api03-test-key-0003';
const keys = { geminiKey: GEMINI_KEY, anthropicKey: ANTHROPIC_KEY };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('realReviewer', () => {
  it('binds the Gemini key and model when the provider is gemini, and never sends the Anthropic key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify(REVIEW) }] } }] }),
    );
    const reviewer = realReviewer({ aiProvider: 'gemini', ...keys }, fetchImpl);

    expect(reviewer.provider).toBe('gemini');
    expect(reviewer.model).toBe(GEMINI_MODEL);
    expect(await reviewer.review(INPUT)).toEqual({ ok: true, review: REVIEW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(GEMINI_URL);
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(GEMINI_KEY);
    expect(JSON.stringify([url, init?.headers, init?.body])).not.toContain(ANTHROPIC_KEY);
  });

  it('binds the Anthropic key and Claude Haiku 5.5 when the provider is claude, and never sends the Gemini key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: CLAUDE_REVIEW_MODEL,
        content: [{ type: 'text', text: JSON.stringify(REVIEW) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 80 },
      }),
    );
    const reviewer = realReviewer({ aiProvider: 'claude', ...keys }, fetchImpl);

    expect(reviewer.provider).toBe('claude');
    expect(reviewer.model).toBe('claude-haiku-5-5');
    expect(await reviewer.review(INPUT)).toEqual({ ok: true, review: REVIEW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect([...new Headers(init?.headers).values()].some((v) => v.includes(ANTHROPIC_KEY))).toBe(
      true,
    );
    expect(
      JSON.stringify([String(url), [...new Headers(init?.headers)], init?.body]),
    ).not.toContain(GEMINI_KEY);
  });

  it('has a model of its own per provider: the shared cache key tells them apart', () => {
    const gemini = realReviewer({ aiProvider: 'gemini', ...keys });
    const claude = realReviewer({ aiProvider: 'claude', ...keys });
    expect(gemini.model).not.toBe(claude.model);
  });
});

describe('upstreamReason', () => {
  it.each(['photo', 'network', 'unavailable', 'invalid_answer'] as const)('keeps %s', (reason) => {
    expect(upstreamReason(reason)).toBe(reason);
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing', 'quota'] as const)(
    'tells a client nothing about the key: %s reads as unavailable',
    (reason) => {
      expect(upstreamReason(reason)).toBe('unavailable');
    },
  );
});

describe('isOwnerProblem', () => {
  it.each(['invalid', 'restricted', 'disabled', 'billing', 'quota', 'unavailable'] as const)(
    '%s is the owner to fix',
    (reason) => {
      expect(isOwnerProblem(reason)).toBe(true);
    },
  );

  it.each(['photo', 'network', 'invalid_answer'] as const)('%s is not', (reason) => {
    expect(isOwnerProblem(reason)).toBe(false);
  });
});
