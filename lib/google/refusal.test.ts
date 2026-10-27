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
    for (const reason of ['quota', 'network', 'photo', 'unavailable', 'invalid_answer']) {
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

  it('blames the image for an unrecognised 400 (by default) or 413, the key for anything else', async () => {
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

  it('can blame the service for an unrecognised 400, but never for a 413', async () => {
    // ... said specific to the request, as it may be this very photo: not for the next listings.
    expect(await readRefusal(new Response('{}', { status: 400 }), 'unavailable')).toEqual({
      reason: 'unavailable',
      refundable: false,
      specific: true,
    });
    expect(await readRefusal(new Response('{}', { status: 413 }), 'unavailable')).toEqual({
      reason: 'photo',
      refundable: false,
    });
  });

  it('calls a 404 unavailable, never a bad key, and refunds it only when Google says NOT_FOUND', async () => {
    expect(await readRefusal(new Response('nothing here', { status: 404 }))).toEqual({
      reason: 'unavailable',
      refundable: false,
    });
    expect(await readRefusal(new Response('{}', { status: 404 }), 'unavailable')).toEqual({
      reason: 'unavailable',
      refundable: false,
    });
    expect(await readRefusal(named(404, 'NOT_FOUND', 'OTHER'))).toEqual({
      reason: 'unavailable',
      refundable: true,
    });
    // Google names NOT_FOUND on another status too: still a service that is gone.
    expect(await readRefusal(named(400, 'NOT_FOUND', 'OTHER'))).toEqual({
      reason: 'unavailable',
      refundable: true,
    });
  });

  it('keeps a refusal Google names as a key problem a key problem, whatever the 400 default', async () => {
    expect(
      await readRefusal(named(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'unavailable'),
    ).toEqual({
      reason: 'invalid',
      refundable: true,
    });
  });
});
