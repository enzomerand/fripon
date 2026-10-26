/** The part of `fetch` that the background's helpers use, so tests can hand them a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
