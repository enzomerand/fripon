import { describe, expect, it } from 'vitest';
import { isKeyFailure, readRefusal } from './refusal';

const named = (status: number, state: string, reason: string) =>
  new Response(
    JSON.stringify({
      error: { code: status, status: state, message: 'Refused.', details: [{ reason }] },
    }),
    { status },
  );

describe('isKeyFailure', () => {
  it('is true for the failures the user fixes in Google Cloud', () => {
    for (const reason of ['invalid', 'restricted', 'disabled', 'billing']) {
      expect(isKeyFailure(reason)).toBe(true);
    }
  });

  it('is false for the others', () => {
    for (const reason of ['quota', 'network', 'photo', 'invalid_answer']) {
      expect(isKeyFailure(reason)).toBe(false);
    }
  });
});

describe('readRefusal', () => {
  it.each([400, 403, 429])(
    'allows the refund of a refusal Google names on a %s',
    async (status) => {
      expect(await readRefusal(named(status, 'X', 'API_KEY_INVALID'))).toEqual({
        reason: 'invalid',
        refundable: true,
      });
    },
  );

  it('keeps the credit of a named refusal on any other status', async () => {
    expect(await readRefusal(named(401, 'UNAUTHENTICATED', 'API_KEY_INVALID'))).toEqual({
      reason: 'invalid',
      refundable: false,
    });
  });

  it('reads a bare 429 as a quota that proves nothing about billing', async () => {
    expect(await readRefusal(new Response('slow down', { status: 429 }))).toEqual({
      reason: 'quota',
      refundable: false,
    });
  });

  it('blames the image for an unrecognised 400 or 413, the key for anything else', async () => {
    expect(await readRefusal(new Response('{}', { status: 400 }))).toEqual({
      reason: 'photo',
      refundable: false,
    });
    expect(await readRefusal(new Response('{}', { status: 413 }))).toEqual({
      reason: 'photo',
      refundable: false,
    });
    expect(await readRefusal(new Response('{}', { status: 403 }))).toEqual({
      reason: 'invalid',
      refundable: false,
    });
  });
});
