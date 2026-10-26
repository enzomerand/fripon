import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_CACHE_MAX_ENTRIES,
  IMAGE_FETCH_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  createImageAnalyzer,
  fetchGuardedImage,
  isAllowedImageUrl,
  type ImageAnalyzerDeps,
} from './analyzer';

const URL_OK = 'https://images1.vinted.net/t/01_a/f800/a.webp?s=aa';
const PIXELS = { hash: '00ff00ff00ff00ff', catalogScore: 0.4 };

function imageResponse(body: BodyInit = 'pixels', init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/webp' }, ...init });
}

function setup(fetchImpl: ImageAnalyzerDeps['fetch'] = () => Promise.resolve(imageResponse())) {
  const fetchMock = vi.fn(fetchImpl);
  const computePixels = vi.fn<ImageAnalyzerDeps['computePixels']>(() => Promise.resolve(PIXELS));
  const analyze = createImageAnalyzer({ fetch: fetchMock, computePixels });
  return { analyze, fetchMock, computePixels };
}

describe('isAllowedImageUrl', () => {
  it('accepts https URLs on the Vinted CDN', () => {
    expect(isAllowedImageUrl(URL_OK)).toBe(true);
    expect(isAllowedImageUrl('https://images2.vinted.net/tc/1/abc.jpeg')).toBe(true);
    // The default https port is the same as no port.
    expect(isAllowedImageUrl('https://images1.vinted.net:443/a.jpg')).toBe(true);
  });

  it.each([
    ['http scheme', 'http://images1.vinted.net/a.jpg'],
    ['other host', 'https://evil.example/a.jpg'],
    ['lookalike suffix', 'https://notvinted.net/a.jpg'],
    ['lookalike subdomain', 'https://images1.vinted.net.evil.example/a.jpg'],
    ['bare domain', 'https://vinted.net/a.jpg'],
    ['credentials', 'https://user:pass@images1.vinted.net/a.jpg'],
    ['custom port', 'https://images1.vinted.net:8443/a.jpg'],
    ['default port spelled out as http port', 'https://images1.vinted.net:80/a.jpg'],
    ['other scheme', 'data:image/png;base64,AAAA'],
    ['not a URL', 'nope'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedImageUrl(url)).toBe(false);
  });
});

describe('createImageAnalyzer', () => {
  it('fetches, decodes and returns the hash and catalogue score', async () => {
    const { analyze, computePixels } = setup();
    await expect(analyze(URL_OK)).resolves.toEqual({ ok: true, ...PIXELS });
    expect(computePixels).toHaveBeenCalledOnce();
  });

  it('refuses a foreign URL without touching the network or the cache', async () => {
    const { analyze, fetchMock } = setup();
    await expect(analyze('https://evil.example/a.jpg')).resolves.toEqual({
      ok: false,
      error: 'URL not allowed',
    });
    await expect(analyze('http://images1.vinted.net/a.jpg')).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never follows a redirect, sends no credentials and has a timeout', async () => {
    const { analyze, fetchMock } = setup();
    await analyze(URL_OK);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(IMAGE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('reports a redirect (fetch rejects) or an HTTP error as a failure', async () => {
    const redirected = setup(() => Promise.reject(new TypeError('redirect mode is set to error')));
    await expect(redirected.analyze(URL_OK)).resolves.toMatchObject({ ok: false });

    const missing = setup(() => Promise.resolve(imageResponse('', { status: 404 })));
    await expect(missing.analyze(URL_OK)).resolves.toEqual({ ok: false, error: 'HTTP 404' });
  });

  it('refuses a response that ends up on another host', async () => {
    const response = imageResponse();
    Object.defineProperty(response, 'url', { value: 'https://evil.example/a.jpg' });
    const { analyze, computePixels } = setup(() => Promise.resolve(response));
    await expect(analyze(URL_OK)).resolves.toEqual({ ok: false, error: 'Unexpected image host' });
    expect(computePixels).not.toHaveBeenCalled();
  });

  it('refuses a photo whose declared size is over the limit', async () => {
    const { analyze, computePixels } = setup(() =>
      Promise.resolve(
        imageResponse('x', { headers: { 'content-length': String(IMAGE_MAX_BYTES + 1) } }),
      ),
    );
    await expect(analyze(URL_OK)).resolves.toEqual({ ok: false, error: 'Image too large' });
    expect(computePixels).not.toHaveBeenCalled();
  });

  it('refuses a body that outgrows the limit while streaming', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(chunk);
      },
    });
    const { analyze, computePixels } = setup(() => Promise.resolve(imageResponse(stream)));
    await expect(analyze(URL_OK)).resolves.toEqual({ ok: false, error: 'Image too large' });
    expect(computePixels).not.toHaveBeenCalled();
    // It stopped reading shortly after the limit instead of draining an endless body.
    expect(sent).toBeLessThan(IMAGE_MAX_BYTES / chunk.byteLength + 5);
  });

  it('caches successes', async () => {
    const { analyze, fetchMock } = setup();
    await analyze(URL_OK);
    await analyze(URL_OK);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('downloads a photo asked twice at once only once', async () => {
    const { analyze, fetchMock, computePixels } = setup();
    const [a, b] = await Promise.all([analyze(URL_OK), analyze(URL_OK)]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(computePixels).toHaveBeenCalledOnce();
  });

  it('does not cache failures: the next request retries', async () => {
    let attempt = 0;
    const { analyze, fetchMock } = setup(() =>
      attempt++ === 0 ? Promise.reject(new Error('offline')) : Promise.resolve(imageResponse()),
    );
    await expect(analyze(URL_OK)).resolves.toEqual({ ok: false, error: 'offline' });
    await expect(analyze(URL_OK)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry beyond the cache size', async () => {
    const { analyze, fetchMock } = setup();
    const url = (n: number) => `https://images1.vinted.net/t/${n}/f800/a.webp`;
    for (let n = 0; n <= IMAGE_CACHE_MAX_ENTRIES; n++) await analyze(url(n));
    expect(fetchMock).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 1);

    await analyze(url(1)); // still cached
    expect(fetchMock).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 1);
    await analyze(url(0)); // evicted
    expect(fetchMock).toHaveBeenCalledTimes(IMAGE_CACHE_MAX_ENTRIES + 2);
  });
});

// The download the photo search shares with the analyzer: the same guards, without the pixels.
describe('fetchGuardedImage', () => {
  it('returns the photo bytes', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(imageResponse('abc')));
    const blob = await fetchGuardedImage(fetchMock, URL_OK);
    expect(await blob.text()).toBe('abc');
    expect(fetchMock).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    );
  });

  it('refuses a foreign URL without touching the network', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(imageResponse()));
    await expect(fetchGuardedImage(fetchMock, 'https://evil.example/a.jpg')).rejects.toThrow(
      'URL not allowed',
    );
    await expect(
      fetchGuardedImage(fetchMock, 'https://images1.vinted.net:8443/a.jpg'),
    ).rejects.toThrow('URL not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails on an HTTP error, a foreign final host and an oversized photo', async () => {
    const missing = () => Promise.resolve(imageResponse('', { status: 404 }));
    await expect(fetchGuardedImage(missing, URL_OK)).rejects.toThrow('HTTP 404');

    const moved = imageResponse();
    Object.defineProperty(moved, 'url', { value: 'https://evil.example/a.jpg' });
    await expect(fetchGuardedImage(() => Promise.resolve(moved), URL_OK)).rejects.toThrow(
      'Unexpected image host',
    );

    const huge = () =>
      Promise.resolve(
        imageResponse('x', { headers: { 'content-length': String(IMAGE_MAX_BYTES + 1) } }),
      );
    await expect(fetchGuardedImage(huge, URL_OK)).rejects.toThrow('Image too large');
  });
});
