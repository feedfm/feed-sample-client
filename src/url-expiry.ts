export type Expiry = 'valid' | 'expired' | 'unknown';

/**
 * Read CloudFront's `Expires` query parameter, a Unix epoch timestamp in
 * seconds. This is the authoritative expiry signal, so it is preferred over
 * any guess based on how long ago the play was reserved.
 *
 * Returns 'unknown' when the URL carries no `Expires` — stage serves unsigned
 * URLs — so callers fall back to the age heuristic rather than assuming the
 * worst.
 */
export function urlExpiry(url: string, marginSeconds: number, nowMs: number): Expiry {
  let expires: string | null;
  try {
    expires = new URL(url).searchParams.get('Expires');
  } catch {
    return 'unknown';
  }

  if (expires === null) return 'unknown';

  const seconds = Number(expires);
  if (!Number.isFinite(seconds)) return 'unknown';

  return seconds * 1000 > nowMs + marginSeconds * 1000 ? 'valid' : 'expired';
}
