/** Characters turned into a binary string at once: `fromCharCode` chokes on very long argument lists. */
const BASE64_CHUNK = 0x8000;

/** Base64 of some bytes, with no `Buffer` (the service worker has none). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** Base64 of a downloaded photo, as the paid Google calls take it. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
