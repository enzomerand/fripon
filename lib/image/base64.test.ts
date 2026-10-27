import { describe, expect, it } from 'vitest';
import { blobToBase64, bytesToBase64 } from './base64';

describe('bytesToBase64', () => {
  it('encodes small and large inputs like the standard base64', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe('AQID');
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('blobToBase64', () => {
  it('encodes the bytes of a downloaded photo', async () => {
    expect(await blobToBase64(new Blob([new Uint8Array([1, 2, 3])]))).toBe('AQID');
  });
});
