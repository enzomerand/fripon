export type JsonObject = Record<string, unknown>;

/** true for a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
