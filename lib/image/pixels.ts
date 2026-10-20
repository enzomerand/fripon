/** Pure pixel heuristics on RGBA buffers (`ImageData.data` layout). No DOM access. */

/** Width and height of the grid a difference hash is computed on: 8 rows of 8 comparisons. */
export const HASH_COLUMNS = 9;
export const HASH_ROWS = 8;

/** Thickness of the border band inspected for a studio backdrop, as a share of each side. */
export const BORDER_BAND_FRACTION = 0.08;
/** A border pixel is "background" when every channel is within this distance of the band's median colour. */
export const BORDER_COLOR_TOLERANCE = 24;
/** Luma (0..255) of the background below which it is not a light studio backdrop at all. */
export const BACKDROP_MIN_LUMA = 140;
/** Luma from which the backdrop counts as fully light. */
export const BACKDROP_FULL_LUMA = 200;

/** Rec. 601 luma. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Grayscale of pixel `i`, with transparency composited on white. */
function grayAt(pixels: Uint8ClampedArray, i: number): number {
  const a = (pixels[i + 3] ?? 255) / 255;
  return luma(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0) * a + 255 * (1 - a);
}

/**
 * 64-bit difference hash: grayscale, box-resize to 9x8, then one bit per horizontal
 * neighbour pair (left brighter than right). Robust to rescaling and mild colour changes.
 */
export function dHash(pixels: Uint8ClampedArray, width: number, height: number): bigint {
  const grid: number[][] = [];
  for (let gy = 0; gy < HASH_ROWS; gy++) {
    const y0 = Math.floor((gy * height) / HASH_ROWS);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / HASH_ROWS));
    const row: number[] = [];
    for (let gx = 0; gx < HASH_COLUMNS; gx++) {
      const x0 = Math.floor((gx * width) / HASH_COLUMNS);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / HASH_COLUMNS));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          sum += grayAt(pixels, (y * width + x) * 4);
          count++;
        }
      }
      row.push(count > 0 ? sum / count : 0);
    }
    grid.push(row);
  }

  let hash = 0n;
  for (const row of grid) {
    for (let x = 0; x < HASH_COLUMNS - 1; x++) {
      hash = (hash << 1n) | ((row[x] ?? 0) > (row[x + 1] ?? 0) ? 1n : 0n);
    }
  }
  return hash;
}

/** Number of differing bits between two hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let bits = 0;
  while (diff > 0n) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits;
}

/** 16-digit lowercase hex, the form hashes travel in between extension contexts. */
export function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

export function hexToHash(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

function median(histogram: Uint32Array, total: number): number {
  let seen = 0;
  for (let v = 0; v < histogram.length; v++) {
    seen += histogram[v] ?? 0;
    if (seen * 2 >= total) return v;
  }
  return 0;
}

/**
 * 0..1 estimate that the picture is a studio / catalogue shot: how much of the outer
 * border band is one uniform, light colour (a seamless backdrop), as opposed to a room,
 * a street or a cluttered wall. Heuristic only, it never proves anything alone.
 */
export function catalogScore(pixels: Uint8ClampedArray, width: number, height: number): number {
  if (width < 1 || height < 1) return 0;
  const bandX = Math.max(1, Math.round(width * BORDER_BAND_FRACTION));
  const bandY = Math.max(1, Math.round(height * BORDER_BAND_FRACTION));
  const inBand = (x: number, y: number) =>
    x < bandX || x >= width - bandX || y < bandY || y >= height - bandY;

  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inBand(x, y)) continue;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const h = histograms[c];
        const v = pixels[i + c] ?? 0;
        if (h) h[v] = (h[v] ?? 0) + 1;
      }
      total++;
    }
  }
  if (total === 0) return 0;

  const [mr, mg, mb] = histograms.map((h) => median(h, total)) as [number, number, number];
  let uniform = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inBand(x, y)) continue;
      const i = (y * width + x) * 4;
      if (
        Math.abs((pixels[i] ?? 0) - mr) <= BORDER_COLOR_TOLERANCE &&
        Math.abs((pixels[i + 1] ?? 0) - mg) <= BORDER_COLOR_TOLERANCE &&
        Math.abs((pixels[i + 2] ?? 0) - mb) <= BORDER_COLOR_TOLERANCE
      ) {
        uniform++;
      }
    }
  }

  const lightness = Math.min(
    1,
    Math.max(0, (luma(mr, mg, mb) - BACKDROP_MIN_LUMA) / (BACKDROP_FULL_LUMA - BACKDROP_MIN_LUMA)),
  );
  return (uniform / total) * lightness;
}
