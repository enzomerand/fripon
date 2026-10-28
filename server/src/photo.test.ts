import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../lib/fetch';
import { IMAGE_MAX_BYTES } from '../../lib/image/guarded-fetch';
import { downloadPhoto, isAcceptablePhotoUrl } from './photo';

const URL_OK = 'https://images1.vinted.net/t/01_00a1b/f800/1234567890.jpeg?s=abc';
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const image = (type = 'image/jpeg', body: Uint8Array = BYTES) =>
  new Response(body, { headers: { 'content-type': type } });

describe('isAcceptablePhotoUrl', () => {
  it.each([
    URL_OK,
    'https://images1.vinted.net/t/01_00a1b/310x430/1234567890.jpeg',
    'https://IMAGES2.VINTED.NET/t/x/f800/y.webp',
  ])('accepts %s', (url) => {
    expect(isAcceptablePhotoUrl(url)).toBe(true);
  });

  it.each([
    ['http', 'http://images1.vinted.net/t/x/f800/y.jpeg'],
    ['another host', 'https://example.com/t/x/f800/y.jpeg'],
    ['a lookalike host', 'https://images1.vinted.net.evil.example/t/x/f800/y.jpeg'],
    ['the bare domain', 'https://vinted.net/t/x/f800/y.jpeg'],
    ['a port', 'https://images1.vinted.net:8443/t/x/f800/y.jpeg'],
    ['credentials', 'https://user:pass@images1.vinted.net/t/x/f800/y.jpeg'],
    ['a 100x100 thumbnail', 'https://images1.vinted.net/t/x/100x100/y.jpeg'],
    ['a 70x100 thumbnail', 'https://images1.vinted.net/t/x/70x100/y.jpeg'],
    ['a data URI', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='],
    ['an address that is not one', 'not a url'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isAcceptablePhotoUrl(url)).toBe(false);
  });
});

describe('downloadPhoto', () => {
  it('returns the photo as base64 with its MIME type', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => image('image/webp'));
    const photo = await downloadPhoto(fetchImpl, URL_OK);
    expect(photo).toEqual({
      base64: Buffer.from(BYTES).toString('base64'),
      mimeType: 'image/webp',
    });
  });

  it('downloads with the extension guards: no redirect followed, no cookies, a timeout', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => image());
    await downloadPhoto(fetchImpl, URL_OK);
    expect(fetchImpl).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({
        redirect: 'error',
        credentials: 'omit',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('never calls out for an address that is not allowed', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => image());
    expect(await downloadPhoto(fetchImpl, 'https://example.com/a.jpg')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an answer that is not an image', async () => {
    expect(await downloadPhoto(async () => image('text/html'), URL_OK)).toBeNull();
    expect(await downloadPhoto(async () => image(''), URL_OK)).toBeNull();
  });

  it('refuses an HTTP error, a failed request and a final host outside the CDN', async () => {
    expect(await downloadPhoto(async () => new Response('x', { status: 404 }), URL_OK)).toBeNull();
    expect(
      await downloadPhoto(async () => {
        throw new TypeError('redirect mode is set to error');
      }, URL_OK),
    ).toBeNull();

    const redirected = image();
    Object.defineProperty(redirected, 'url', { value: 'https://evil.example/a.jpg' });
    expect(await downloadPhoto(async () => redirected, URL_OK)).toBeNull();
  });

  it('refuses a photo above 8 MB, declared or not', async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    expect(await downloadPhoto(async () => image('image/jpeg', big), URL_OK)).toBeNull();

    const declared = new Response(BYTES, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(IMAGE_MAX_BYTES + 1) },
    });
    expect(await downloadPhoto(async () => declared, URL_OK)).toBeNull();
  });

  it('accepts a photo of exactly 8 MB', async () => {
    const exact = new Uint8Array(IMAGE_MAX_BYTES);
    expect(await downloadPhoto(async () => image('image/jpeg', exact), URL_OK)).not.toBeNull();
  });
});
