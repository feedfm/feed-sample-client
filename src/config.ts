export const DEFAULT_BASE_URL = 'https://feed.fm';
export const CLIENT_ID_STORAGE_PREFIX = 'feed.fm.client_id.';

/** Fallback only, used when an audio URL carries no `Expires` parameter. */
export const RESERVATION_TTL_MS = 900_000;

/** Treat a URL as expired this many seconds before its stated `Expires`. */
export const URL_EXPIRY_MARGIN_SECONDS = 30;

/** How many times a single load may be retried purely because the URL expired. */
export const MAX_EXPIRY_REFETCHES = 2;

/** How many genuinely bad plays in a row before the player gives up. */
export const MAX_CONSECUTIVE_PLAY_FAILURES = 3;

export const ELAPSE_INTERVAL_MS = 10_000;
export const TICK_INTERVAL_MS = 1_000;
