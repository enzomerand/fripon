import { describe, expect, it } from 'vitest';
import { photoKey } from '../../lib/image/photo-url';
import { dropSizeSegment, serverPhotoKey } from './photo-key';

const BASE = 'https://images1.vinted.net/t/01_00a1b';

describe('serverPhotoKey', () => {
  it.each(['f800', 'f1200', 'f400', '310x430', '1200x1200', '150x210'])(
    'drops the %s size segment',
    (size) => {
      expect(serverPhotoKey(`${BASE}/${size}/1234567890.jpeg`)).toBe(`${BASE}/1234567890.jpeg`);
    },
  );

  it('gives one key to a photo seen in a grid and on its page, whatever the signature', () => {
    const grid = serverPhotoKey(`${BASE}/310x430/1234567890.jpeg?s=grid`);
    const page = serverPhotoKey(`${BASE}/f800/1234567890.jpeg?s=page`);
    expect(grid).toBe(page);
    expect(page).toBe(`${BASE}/1234567890.jpeg`);
  });

  it('keeps two photos apart', () => {
    expect(serverPhotoKey(`${BASE}/f800/1.jpeg`)).not.toBe(serverPhotoKey(`${BASE}/f800/2.jpeg`));
    expect(serverPhotoKey('https://images1.vinted.net/t/01_a/f800/1.jpeg')).not.toBe(
      serverPhotoKey('https://images1.vinted.net/t/01_b/f800/1.jpeg'),
    );
  });

  it('leaves a path with no size segment as the extension reads it', () => {
    for (const url of [
      'https://images1.vinted.net/tc/01_aa/aa.jpeg?s=3',
      'https://images1.vinted.net/a.jpg',
      'https://images1.vinted.net/t/01_a/main.webp',
    ]) {
      expect(serverPhotoKey(url)).toBe(photoKey(url));
    }
  });

  it('never touches the file name, nor an identifier that only looks like a size', () => {
    expect(serverPhotoKey(`${BASE}/f800/f800`)).toBe(`${BASE}/f800`);
    expect(serverPhotoKey('https://images1.vinted.net/t/f800x/f800/y.jpeg')).toBe(
      'https://images1.vinted.net/t/f800x/y.jpeg',
    );
    expect(serverPhotoKey(`${BASE}/1x1.gif`)).toBe(`${BASE}/1x1.gif`);
  });

  it('throws on what is not a URL, like the extension key', () => {
    expect(() => serverPhotoKey('not a url')).toThrow();
  });
});

describe('dropSizeSegment', () => {
  it('works on a stored key (origin and path), and leaves anything else alone', () => {
    expect(dropSizeSegment(`${BASE}/f800/1.jpeg`)).toBe(`${BASE}/1.jpeg`);
    expect(dropSizeSegment('p')).toBe('p');
    expect(dropSizeSegment('photo-1')).toBe('photo-1');
    expect(dropSizeSegment('https://images1.vinted.net')).toBe('https://images1.vinted.net');
  });
});
