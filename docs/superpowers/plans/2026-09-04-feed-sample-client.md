# feed-sample-client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript SDK that lets browser code start a Feed.fm session, search for a station by name, and play music from it — one stream at a time per `Player`.

**Architecture:** Three layers with hard boundaries. `FeedApiClient` does transport and collapses the API's two error channels into one `FeedError`. `AudioDriver` is the only module that touches the DOM, so everything above it runs in node against a fake. `PlayerImpl` is the state machine that owns the play queue, the timers, and the event emitter.

**Tech Stack:** TypeScript, tsup (ESM + CJS + d.ts), vitest, Playwright (chromium). Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-feed-sample-client-design.md` — read it alongside this plan; the plan argues from it.

## Global Constraints

- Node 20+, TypeScript 5.x, `"type": "module"`, `strict: true` in tsconfig.
- **Zero runtime dependencies.** Everything in `dependencies` is a bug; the emitter is written in-repo.
- API base path is `<baseUrl>/api/v3`. `DEFAULT_BASE_URL` is `https://feed.fm`; tests and e2e use `https://stage.feed.fm`.
- Auth header is `Authorization: Basic base64(token:secret)`. Never `X-Authorization`.
- `client_id` is sent as a body property on every POST.
- `formats` is never sent, so the API default `mp3` applies.
- **Stations are addressed by `uuid` only.** The numeric station id is internal and must never appear on a `Station`, in an event payload, or in an error message.
- **Never trust an HTTP 200.** Codes 7, 9, 12 and 24 arrive with status 200 and `success: false`. Always branch on `success`.
- **Never stop a song for a skip the server did not grant.** A denied skip keeps playing.
- `POST /play/{id}/invalidate` is called in exactly one place: audio that failed to load for a reason *other* than URL expiry. Everywhere else an unused play is discarded with no request.

---

### Task 1: Scaffolding, constants, and the error type

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/config.ts`, `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FeedError` (class with `code: number`, `mnemonic: string`, `status: number`), `ErrorCode` const map, `mnemonicForCode(code: number): string`, and every constant in `src/config.ts`.

- [ ] **Step 1: Create the package files**

`package.json`:

```json
{
  "name": "feed-sample-client",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

`tsup.config.ts`:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

`vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`.gitignore`:

```
node_modules
dist
test-results
playwright-report
```

- [ ] **Step 2: Write `src/config.ts`**

```typescript
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
```

- [ ] **Step 3: Write the failing test**

`test/errors.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ErrorCode, FeedError, mnemonicForCode } from '../src/errors.js';

describe('FeedError', () => {
  it('carries code, mnemonic and status', () => {
    const err = new FeedError(ErrorCode.noMoreMusic, 'no music left', 200);
    expect(err.code).toBe(9);
    expect(err.mnemonic).toBe('noMoreMusic');
    expect(err.status).toBe(200);
    expect(err.message).toBe('no music left');
  });

  it('is an Error and keeps its name', () => {
    const err = new FeedError(ErrorCode.badCredentials, 'nope', 401);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FeedError');
  });

  it('falls back to a generic mnemonic for unknown codes', () => {
    expect(mnemonicForCode(9999)).toBe('unknown');
  });

  it('maps every documented code', () => {
    expect(mnemonicForCode(7)).toBe('skipDenied');
    expect(mnemonicForCode(12)).toBe('playNotActive');
    expect(mnemonicForCode(17)).toBe('missingObject');
    expect(mnemonicForCode(22)).toBe('throttled');
    expect(mnemonicForCode(24)).toBe('formatUnavailable');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm install && npx vitest run test/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 5: Write `src/errors.ts`**

```typescript
export const ErrorCode = {
  badCredentials: 5,
  forbidden: 6,
  skipDenied: 7,
  noMoreMusic: 9,
  playNotActive: 12,
  invalidParameter: 15,
  missingParameter: 16,
  missingObject: 17,
  internalError: 18,
  noMusic: 19,
  playbackStarted: 20,
  playbackComplete: 21,
  throttled: 22,
  notOnDemandOrReplay: 23,
  formatUnavailable: 24,
  /** Not from the API: transport or parse failure on our side. */
  networkError: -1,
} as const;

const MNEMONICS: Record<number, string> = Object.fromEntries(
  Object.entries(ErrorCode).map(([name, code]) => [code, name]),
);

export function mnemonicForCode(code: number): string {
  return MNEMONICS[code] ?? 'unknown';
}

export class FeedError extends Error {
  readonly code: number;
  readonly mnemonic: string;
  readonly status: number;

  constructor(code: number, message: string, status: number) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
    this.mnemonic = mnemonicForCode(code);
    this.status = status;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore src/config.ts src/errors.ts test/errors.test.ts
git commit -m "feat: scaffold package with config constants and FeedError"
```

---

### Task 2: Wire types and URL expiry

**Files:**
- Create: `src/api/schema.ts`, `src/url-expiry.ts`
- Test: `test/url-expiry.test.ts`

**Interfaces:**
- Consumes: `URL_EXPIRY_MARGIN_SECONDS` from `src/config.ts`.
- Produces: wire types `ApiStation`, `MinimalStation`, `AudioFile`, `Play`, `SearchPlay`, `Session`, `SessionResponse`, `StationSearchQuery`; and `urlExpiry(url: string, marginSeconds: number, nowMs: number): Expiry` where `Expiry = 'valid' | 'expired' | 'unknown'`.

- [ ] **Step 1: Write `src/api/schema.ts`**

Transcribed from `spec.v3.yml`. Note `MinimalStation` has **no** `uuid` — that is why a public `Station` can never be built from a play.

```typescript
export interface Track { id: string; title: string; }
export interface Release { id: string; title: string; }
export interface Artist { id: string; name: string; }

export interface AudioFile {
  id: string;
  duration_in_seconds: number;
  codec: string;
  url?: string;
  bitrate?: number;
  track: Track;
  release: Release;
  artist: Artist;
  extra: Record<string, unknown>;
  liked?: true;
  can_seek?: true;
  can_cache?: true;
  preview?: true;
  replaygain_track_gain?: number;
}

/** Stamped onto plays. Carries no uuid — see spec §2. */
export interface MinimalStation { id: string; name: string; pre_gain?: number | null; }

export interface ApiStation {
  id: string;
  uuid: string;
  name: string;
  on_demand: number | boolean;
  pre_gain: number | null;
  options: Record<string, unknown>;
  crossfade_seconds: number;
  single_play: number | boolean;
  last_updated: string;
}

export interface Play { id: string; audio_file: AudioFile; start_at?: number; station?: MinimalStation; }
export interface SearchPlay { id: string; audio_file: AudioFile; start_at?: number; station: ApiStation; }

export interface Session {
  available: boolean;
  client_id: string;
  time: number;
  message?: string;
}

export interface SessionResponse {
  success: boolean;
  session: Session;
  placement?: { id: string; options: Record<string, unknown> };
  stations?: ApiStation[];
}

export interface StationSearchQuery {
  type?: 'radio' | 'first_play' | 'replay';
  filter?: Record<string, unknown>;
  at?: number;
}

export interface FeedErrorBody {
  success: false;
  error: { code: number; message: string; status: number };
}
```

- [ ] **Step 2: Write the failing test**

`test/url-expiry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { urlExpiry } from '../src/url-expiry.js';

const NOW = 1_800_000_000_000; // ms
const nowSeconds = NOW / 1000;

describe('urlExpiry', () => {
  it('reports valid when Expires is comfortably in the future', () => {
    const url = `https://cdn.example/a.mp3?Expires=${nowSeconds + 600}&Signature=x`;
    expect(urlExpiry(url, 30, NOW)).toBe('valid');
  });

  it('reports expired when Expires is in the past', () => {
    const url = `https://cdn.example/a.mp3?Expires=${nowSeconds - 5}&Signature=x`;
    expect(urlExpiry(url, 30, NOW)).toBe('expired');
  });

  it('treats the margin as already expired', () => {
    const url = `https://cdn.example/a.mp3?Expires=${nowSeconds + 10}&Signature=x`;
    expect(urlExpiry(url, 30, NOW)).toBe('expired');
  });

  // Stage serves unsigned URLs with no query string at all. This must not be
  // read as expired, or every play on stage would be re-fetched forever.
  it('reports unknown when there is no query string', () => {
    expect(urlExpiry('https://cdn.example/a.mp3', 30, NOW)).toBe('unknown');
  });

  it('reports unknown when Expires is absent or unparseable', () => {
    expect(urlExpiry('https://cdn.example/a.mp3?Signature=x', 30, NOW)).toBe('unknown');
    expect(urlExpiry('https://cdn.example/a.mp3?Expires=soon', 30, NOW)).toBe('unknown');
  });

  it('reports unknown for a malformed URL rather than throwing', () => {
    expect(urlExpiry('not a url', 30, NOW)).toBe('unknown');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/url-expiry.test.ts`
Expected: FAIL — cannot resolve `../src/url-expiry.js`.

- [ ] **Step 4: Write `src/url-expiry.ts`**

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/url-expiry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/api/schema.ts src/url-expiry.ts test/url-expiry.test.ts
git commit -m "feat: add v3 wire types and URL expiry detection"
```

---

### Task 3: API client transport and error normalization

**Files:**
- Create: `src/api/client.ts`
- Test: `test/api-client-transport.test.ts`

**Interfaces:**
- Consumes: `FeedError`, `ErrorCode` from `src/errors.ts`; `DEFAULT_BASE_URL` from `src/config.ts`; `FeedErrorBody` from `src/api/schema.ts`.
- Produces: `class FeedApiClient` with `constructor(options: FeedApiClientOptions)`, a mutable `clientId: string | undefined` property, and a `protected post<T>(path: string, body: Record<string, unknown>): Promise<T>`. `FeedApiClientOptions = { token: string; secret: string; baseUrl?: string; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

`test/api-client-transport.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { FeedApiClient } from '../src/api/client.js';
import { FeedError } from '../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch, baseUrl?: string) {
  return new FeedApiClient({ token: 'tok', secret: 'sec', baseUrl, fetchImpl });
}

describe('FeedApiClient transport', () => {
  it('sends basic auth in the Authorization header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    await makeClient(fetchImpl as unknown as typeof fetch).post('/status', {});

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe(`Basic ${btoa('tok:sec')}`);
    expect(headers.get('X-Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('appends /api/v3 and normalizes a trailing slash on baseUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    await makeClient(fetchImpl as unknown as typeof fetch, 'https://stage.feed.fm/').post('/session', {});

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://stage.feed.fm/api/v3/session');
  });

  it('defaults to production when no baseUrl is given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    await makeClient(fetchImpl as unknown as typeof fetch).post('/session', {});

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://feed.fm/api/v3/session');
  });

  it('includes client_id in the body once set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    client.clientId = 'abc123';
    await client.post('/play', { station_id: '7' });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ station_id: '7', client_id: 'abc123' });
  });

  // The trap: codes 7, 9, 12 and 24 arrive with HTTP 200.
  it('throws FeedError on HTTP 200 with success:false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, error: { code: 9, message: 'no more music', status: 200 } }),
    );
    const promise = makeClient(fetchImpl as unknown as typeof fetch).post('/play', {});

    await expect(promise).rejects.toBeInstanceOf(FeedError);
    await expect(promise).rejects.toMatchObject({ code: 9, mnemonic: 'noMoreMusic', status: 200 });
  });

  it('throws FeedError on an HTTP error carrying an envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, error: { code: 5, message: 'bad creds', status: 401 } }, 401),
    );
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: 5, mnemonic: 'badCredentials', status: 401 });
  });

  it('throws a networkError FeedError when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: -1, mnemonic: 'networkError' });
  });

  it('throws a networkError FeedError when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>nope</html>', { status: 404 }));
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: -1, mnemonic: 'networkError', status: 404 });
  });

  it('returns the parsed body on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, play: { id: '1' } }));
    const result = await makeClient(fetchImpl as unknown as typeof fetch).post<{ play: { id: string } }>('/play', {});
    expect(result.play.id).toBe('1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api-client-transport.test.ts`
Expected: FAIL — cannot resolve `../src/api/client.js`.

- [ ] **Step 3: Write `src/api/client.ts`**

`post` is public rather than protected so the transport can be tested directly; endpoint methods land in Task 4.

```typescript
import { DEFAULT_BASE_URL } from '../config.js';
import { ErrorCode, FeedError } from '../errors.js';
import type { FeedErrorBody } from './schema.js';

export interface FeedApiClientOptions {
  token: string;
  secret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function basicAuth(token: string, secret: string): string {
  return `Basic ${btoa(`${token}:${secret}`)}`;
}

function isErrorBody(body: unknown): body is FeedErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { success?: unknown }).success === false
  );
}

export class FeedApiClient {
  clientId: string | undefined;

  readonly #root: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;

  constructor(options: FeedApiClientOptions) {
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#root = `${base}/api/v3`;
    this.#auth = basicAuth(options.token, options.secret);
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payload = this.clientId === undefined ? body : { ...body, client_id: this.clientId };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#root}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.#auth },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new FeedError(
        ErrorCode.networkError,
        cause instanceof Error ? cause.message : 'network request failed',
        0,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // Unknown paths under /api/v3 answer with plain HTML, not the envelope.
      throw new FeedError(ErrorCode.networkError, 'response was not JSON', response.status);
    }

    // Never trust a 200: codes 7, 9, 12 and 24 arrive with one.
    if (isErrorBody(parsed)) {
      const { code, message, status } = parsed.error;
      throw new FeedError(code, message, status ?? response.status);
    }

    if (!response.ok) {
      throw new FeedError(ErrorCode.networkError, `HTTP ${response.status}`, response.status);
    }

    return parsed as T;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api-client-transport.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/api-client-transport.test.ts
git commit -m "feat: add API client transport with unified error normalization"
```

---

### Task 4: API client endpoint methods

**Files:**
- Modify: `src/api/client.ts`
- Test: `test/api-client-endpoints.test.ts`

**Interfaces:**
- Consumes: `FeedApiClient.post` from Task 3; wire types from Task 2.
- Produces, all on `FeedApiClient`:
  - `startSession(clientId?: string): Promise<SessionResponse>`
  - `searchStation(query: StationSearchQuery): Promise<SearchPlay>`
  - `createPlay(stationId: string): Promise<Play>`
  - `startPlay(playId: string): Promise<{ canSkip: boolean; canLike: boolean }>`
  - `elapsePlay(playId: string, seconds: number): Promise<void>`
  - `skipPlay(playId: string, seconds: number): Promise<boolean>` — `true` granted, `false` for codes 7 and 12, throws otherwise
  - `completePlay(playId: string): Promise<void>`
  - `invalidatePlay(playId: string, reason: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`test/api-client-endpoints.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedApiClient } from '../src/api/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchImpl: ReturnType<typeof vi.fn>;
let client: FeedApiClient;

beforeEach(() => {
  fetchImpl = vi.fn();
  client = new FeedApiClient({ token: 't', secret: 's', fetchImpl: fetchImpl as unknown as typeof fetch });
  client.clientId = 'cid';
});

function lastCall() {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return { url: url as string, body: JSON.parse((init as RequestInit).body as string) };
}

describe('startSession', () => {
  it('omits client_id entirely when none is known', async () => {
    client.clientId = undefined;
    fetchImpl.mockResolvedValue(jsonResponse({ success: true, session: { available: true, client_id: 'new', time: 1 } }));

    await client.startSession();
    expect(lastCall().body).toEqual({});
  });

  it('sends an explicit client_id when given one', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true, session: { available: true, client_id: 'x', time: 1 } }));

    await client.startSession('x');
    expect(lastCall().url).toBe('https://feed.fm/api/v3/session');
    expect(lastCall().body).toEqual({ client_id: 'x' });
  });
});

describe('searchStation', () => {
  it('wraps the query in the q array and returns the play', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({
      success: true,
      play: { id: '5', audio_file: { id: '1' }, station: { id: '7', uuid: 'u-7', name: 'Pop' } },
      placement: { id: '1', options: {} },
    }));

    const play = await client.searchStation({ filter: { name: 'Pop' } });

    expect(lastCall().url).toBe('https://feed.fm/api/v3/station');
    expect(lastCall().body).toEqual({ client_id: 'cid', q: [{ filter: { name: 'Pop' } }] });
    expect(play.station.uuid).toBe('u-7');
  });

  it('propagates noMoreMusic, which arrives as HTTP 200', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: false, error: { code: 9, message: 'none', status: 200 } }));
    await expect(client.searchStation({ filter: { name: 'Nope' } })).rejects.toMatchObject({ code: 9 });
  });
});

describe('createPlay', () => {
  it('posts the station id and never formats', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true, play: { id: '9', audio_file: { id: '2' } } }));

    const play = await client.createPlay('7');

    expect(lastCall().url).toBe('https://feed.fm/api/v3/play');
    expect(lastCall().body).toEqual({ client_id: 'cid', station_id: '7' });
    expect(play.id).toBe('9');
  });
});

describe('startPlay', () => {
  it('returns the skip and like rights', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true, can_skip: true, can_like: false }));

    const result = await client.startPlay('9');

    expect(lastCall().url).toBe('https://feed.fm/api/v3/play/9/start');
    expect(result).toEqual({ canSkip: true, canLike: false });
  });
});

describe('elapsePlay', () => {
  it('reports whole seconds', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true }));

    await client.elapsePlay('9', 42.7);

    expect(lastCall().url).toBe('https://feed.fm/api/v3/play/9/elapse');
    expect(lastCall().body).toEqual({ client_id: 'cid', seconds: 42 });
  });
});

describe('skipPlay', () => {
  it('returns true when the skip is granted', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true }));
    await expect(client.skipPlay('9', 12)).resolves.toBe(true);
    expect(lastCall().body).toEqual({ client_id: 'cid', seconds: 12 });
  });

  // Licensing: a denial is a normal answer, never an error.
  it('returns false for skipDenied rather than throwing', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: false, error: { code: 7, message: 'no skips', status: 200 } }));
    await expect(client.skipPlay('9', 12)).resolves.toBe(false);
  });

  it('returns false for playNotActive rather than throwing', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: false, error: { code: 12, message: 'not active', status: 200 } }));
    await expect(client.skipPlay('9', 12)).resolves.toBe(false);
  });

  it('still throws for a genuine failure', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: false, error: { code: 17, message: 'no play', status: 404 } }, 404));
    await expect(client.skipPlay('9', 12)).rejects.toMatchObject({ code: 17 });
  });
});

describe('completePlay and invalidatePlay', () => {
  it('completes by play id', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true }));
    await client.completePlay('9');
    expect(lastCall().url).toBe('https://feed.fm/api/v3/play/9/complete');
  });

  it('invalidates with a reason', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ success: true }));
    await client.invalidatePlay('9', 'audio failed to load');
    expect(lastCall().url).toBe('https://feed.fm/api/v3/play/9/invalidate');
    expect(lastCall().body).toEqual({ client_id: 'cid', reason: 'audio failed to load' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api-client-endpoints.test.ts`
Expected: FAIL — `client.startSession is not a function`.

- [ ] **Step 3: Add the endpoint methods to `src/api/client.ts`**

Add these imports at the top:

```typescript
import { ErrorCode } from '../errors.js';
import type { Play, SearchPlay, SessionResponse, StationSearchQuery } from './schema.js';
```

Add these methods to the `FeedApiClient` class body:

```typescript
  async startSession(clientId?: string): Promise<SessionResponse> {
    const body = clientId === undefined ? {} : { client_id: clientId };
    // Bypass the automatic client_id merge: on the very first session there is
    // none, and this is the only route that will mint one for us.
    const saved = this.clientId;
    this.clientId = clientId;
    try {
      return await this.post<SessionResponse>('/session', body);
    } finally {
      this.clientId = saved;
    }
  }

  async searchStation(query: StationSearchQuery): Promise<SearchPlay> {
    const body = await this.post<{ play: SearchPlay }>('/station', { q: [query] });
    return body.play;
  }

  async createPlay(stationId: string): Promise<Play> {
    const body = await this.post<{ play: Play }>('/play', { station_id: stationId });
    return body.play;
  }

  async startPlay(playId: string): Promise<{ canSkip: boolean; canLike: boolean }> {
    const body = await this.post<{ can_skip: boolean; can_like: boolean }>(`/play/${playId}/start`, {});
    return { canSkip: body.can_skip, canLike: body.can_like };
  }

  async elapsePlay(playId: string, seconds: number): Promise<void> {
    await this.post(`/play/${playId}/elapse`, { seconds: Math.floor(seconds) });
  }

  /**
   * Returns false when the server refuses. The caller MUST keep playing on a
   * false: stopping a song without a granted skip breaches the licensing
   * protocol and can get credentials revoked.
   */
  async skipPlay(playId: string, seconds: number): Promise<boolean> {
    try {
      await this.post(`/play/${playId}/skip`, { seconds: Math.floor(seconds) });
      return true;
    } catch (error) {
      if (
        error instanceof FeedError &&
        (error.code === ErrorCode.skipDenied || error.code === ErrorCode.playNotActive)
      ) {
        return false;
      }
      throw error;
    }
  }

  async completePlay(playId: string): Promise<void> {
    await this.post(`/play/${playId}/complete`, {});
  }

  async invalidatePlay(playId: string, reason: string): Promise<void> {
    await this.post(`/play/${playId}/invalidate`, { reason });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api-client-endpoints.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/api-client-endpoints.test.ts
git commit -m "feat: add API client endpoint methods"
```

---

### Task 5: Typed event emitter

**Files:**
- Create: `src/types.ts`, `src/player/emitter.ts`
- Test: `test/emitter.test.ts`

**Interfaces:**
- Consumes: `FeedError` from `src/errors.ts`.
- Produces: `Station`, `SongMetadata`, `PlayerStatus`, `StopReason`, `PlayerEvents`, `Player`, `ConnectOptions` in `src/types.ts`; `class Emitter<E>` with `on`, `off`, `emit` in `src/player/emitter.ts`.

- [ ] **Step 1: Write `src/types.ts`**

```typescript
import type { FeedError } from './errors.js';

export interface ConnectOptions {
  token: string;
  secret: string;
  clientId?: string;
  baseUrl?: string;
}

/**
 * A station, addressed by uuid. The numeric station id the API uses is
 * internal to the SDK and never appears here.
 */
export interface Station {
  uuid: string;
  name: string;
  options: Record<string, unknown>;
}

export interface SongMetadata {
  title: string;
  artist: string;
  release: string;
  durationInSeconds: number;
  elapsedInSeconds: number;
}

export type PlayerStatus = 'stopped' | 'playing' | 'paused';

export type StopReason = 'ended' | 'stopped-by-caller' | 'superseded' | 'error';

export interface PlayerEvents {
  'play-started': (song: SongMetadata) => void;
  'play-elapsed': (song: SongMetadata) => void;
  'play-paused': (song: SongMetadata) => void;
  'play-stopped': (info: { reason: StopReason }) => void;
  'buffering-started': () => void;
  'buffering-ended': () => void;
  error: (error: FeedError) => void;
}

export interface Player {
  clientId(): string;
  status(): PlayerStatus;
  buffering(): boolean;
  activeSong(): SongMetadata | null;
  findStation(query: string): Promise<Station | null>;
  play(station: Station): void;
  pause(): void;
  resume(): void;
  skip(): Promise<boolean>;
  stop(): void;
  on<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
  off<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void;
}
```

- [ ] **Step 2: Write the failing test**

`test/emitter.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/player/emitter.js';

type Events = { ping: (n: number) => void; pong: () => void };

describe('Emitter', () => {
  it('calls every handler registered for an event', () => {
    const emitter = new Emitter<Events>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('ping', b);

    emitter.emit('ping', 42);

    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it('does not call handlers for other events', () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on('pong', handler);

    emitter.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes a handler with off', () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on('ping', handler);
    emitter.off('ping', handler);

    emitter.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('is a no-op when emitting with no handlers', () => {
    expect(() => new Emitter<Events>().emit('ping', 1)).not.toThrow();
  });

  // One badly behaved consumer must not stop the player notifying the others.
  it('keeps calling later handlers when an earlier one throws', () => {
    const emitter = new Emitter<Events>();
    const later = vi.fn();
    emitter.on('ping', () => { throw new Error('consumer bug'); });
    emitter.on('ping', later);

    expect(() => emitter.emit('ping', 1)).not.toThrow();
    expect(later).toHaveBeenCalledWith(1);
  });

  it('tolerates a handler removing itself during emit', () => {
    const emitter = new Emitter<Events>();
    const once = vi.fn(() => emitter.off('ping', once));
    const after = vi.fn();
    emitter.on('ping', once);
    emitter.on('ping', after);

    emitter.emit('ping', 1);
    emitter.emit('ping', 2);

    expect(once).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts`
Expected: FAIL — cannot resolve `../src/player/emitter.js`.

- [ ] **Step 4: Write `src/player/emitter.ts`**

```typescript
type AnyHandler = (...args: never[]) => void;

export class Emitter<E extends Record<string, AnyHandler>> {
  readonly #handlers = new Map<keyof E, Set<AnyHandler>>();

  on<K extends keyof E>(event: K, handler: E[K]): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
  }

  off<K extends keyof E>(event: K, handler: E[K]): void {
    this.#handlers.get(event)?.delete(handler as AnyHandler);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.#handlers.get(event);
    if (set === undefined) return;

    // Copy first: a handler may add or remove handlers while we iterate.
    for (const handler of [...set]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch {
        // A consumer's bug must not break the player or starve later handlers.
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/player/emitter.ts test/emitter.test.ts
git commit -m "feat: add public types and typed event emitter"
```

---

### Task 6: Station records and reservation freshness

**Files:**
- Create: `src/player/stations.ts`, `src/player/reservations.ts`
- Test: `test/stations.test.ts`, `test/reservations.test.ts`

**Interfaces:**
- Consumes: `ApiStation`, `Play`, `SearchPlay` from Task 2; `urlExpiry` from Task 2; `RESERVATION_TTL_MS`, `URL_EXPIRY_MARGIN_SECONDS` from Task 1; `Station` from Task 5.
- Produces:
  - `interface StationRecord { uuid: string; id: string; name: string; options: Record<string, unknown> }`
  - `toStationRecord(station: ApiStation): StationRecord`
  - `toPublicStation(record: StationRecord): Station`
  - `interface Reservation { play: Play | SearchPlay; reservedAt: number; startedCountAtReserve: number }`
  - `isReservationFresh(reservation: Reservation, playsStartedCount: number, nowMs: number): boolean`
  - `class ReservationStore` with `put(uuid, reservation)`, `take(uuid): Reservation | undefined`, `discard(uuid)`

- [ ] **Step 1: Write the failing station test**

`test/stations.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toPublicStation, toStationRecord } from '../src/player/stations.js';
import type { ApiStation } from '../src/api/schema.js';

const apiStation: ApiStation = {
  id: '33714093',
  uuid: 'u-abc',
  name: 'Station One',
  on_demand: 1,
  pre_gain: 12,
  options: { genre: 'pop' },
  crossfade_seconds: 0,
  single_play: 0,
  last_updated: '2026-01-01',
};

describe('station mapping', () => {
  it('keeps the numeric id on the internal record', () => {
    expect(toStationRecord(apiStation)).toEqual({
      uuid: 'u-abc',
      id: '33714093',
      name: 'Station One',
      options: { genre: 'pop' },
    });
  });

  it('exposes only uuid, name and options publicly', () => {
    const station = toPublicStation(toStationRecord(apiStation));
    expect(Object.keys(station).sort()).toEqual(['name', 'options', 'uuid']);
  });

  // The leak guard: the numeric id must not survive serialization.
  it('never leaks the numeric station id through JSON', () => {
    const serialized = JSON.stringify(toPublicStation(toStationRecord(apiStation)));
    expect(serialized).not.toContain('33714093');
    expect(serialized).not.toContain('"id"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stations.test.ts`
Expected: FAIL — cannot resolve `../src/player/stations.js`.

- [ ] **Step 3: Write `src/player/stations.ts`**

```typescript
import type { ApiStation } from '../api/schema.js';
import type { Station } from '../types.js';

/** Internal only. Holds the numeric id the API needs for POST /play. */
export interface StationRecord {
  uuid: string;
  id: string;
  name: string;
  options: Record<string, unknown>;
}

export function toStationRecord(station: ApiStation): StationRecord {
  return {
    uuid: station.uuid,
    id: station.id,
    name: station.name,
    options: station.options ?? {},
  };
}

/**
 * Builds the public object field by field rather than spreading the record and
 * deleting `id`, so the numeric id cannot survive into JSON, a log line, or an
 * event payload.
 */
export function toPublicStation(record: StationRecord): Station {
  return { uuid: record.uuid, name: record.name, options: record.options };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stations.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing reservation test**

`test/reservations.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ReservationStore, isReservationFresh, type Reservation } from '../src/player/reservations.js';
import type { Play } from '../src/api/schema.js';

const NOW = 1_800_000_000_000;
const nowSeconds = NOW / 1000;

function play(url: string | undefined): Play {
  return {
    id: '1',
    audio_file: {
      id: 'a1',
      duration_in_seconds: 100,
      codec: 'mp3',
      url,
      track: { id: 't', title: 'T' },
      release: { id: 'r', title: 'R' },
      artist: { id: 'ar', name: 'A' },
      extra: {},
    },
  };
}

function reservation(url: string | undefined, overrides: Partial<Reservation> = {}): Reservation {
  return { play: play(url), reservedAt: NOW, startedCountAtReserve: 0, ...overrides };
}

describe('isReservationFresh', () => {
  it('is fresh when Expires is in the future and no play has started since', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds + 600}`);
    expect(isReservationFresh(r, 0, NOW)).toBe(true);
  });

  it('is stale once another play has been started', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds + 600}`);
    expect(isReservationFresh(r, 1, NOW)).toBe(false);
  });

  it('is stale when Expires has passed, however recently it was reserved', () => {
    const r = reservation(`https://cdn/a.mp3?Expires=${nowSeconds - 1}`);
    expect(isReservationFresh(r, 0, NOW)).toBe(false);
  });

  // Stage serves unsigned URLs, so absence of Expires falls back to age.
  it('falls back to the age heuristic when there is no Expires', () => {
    const recent = reservation('https://cdn/a.mp3', { reservedAt: NOW - 60_000 });
    const old = reservation('https://cdn/a.mp3', { reservedAt: NOW - 1_000_000 });
    expect(isReservationFresh(recent, 0, NOW)).toBe(true);
    expect(isReservationFresh(old, 0, NOW)).toBe(false);
  });

  it('is stale when the play has no audio url at all', () => {
    expect(isReservationFresh(reservation(undefined), 0, NOW)).toBe(false);
  });
});

describe('ReservationStore', () => {
  it('take returns the reservation and removes it', () => {
    const store = new ReservationStore();
    const r = reservation('https://cdn/a.mp3');
    store.put('u-1', r);

    expect(store.take('u-1')).toBe(r);
    expect(store.take('u-1')).toBeUndefined();
  });

  it('put replaces an existing reservation for the same station', () => {
    const store = new ReservationStore();
    const first = reservation('https://cdn/a.mp3');
    const second = reservation('https://cdn/b.mp3');
    store.put('u-1', first);
    store.put('u-1', second);

    expect(store.take('u-1')).toBe(second);
  });

  it('discard drops a reservation without any request', () => {
    const store = new ReservationStore();
    store.put('u-1', reservation('https://cdn/a.mp3'));
    store.discard('u-1');

    expect(store.take('u-1')).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/reservations.test.ts`
Expected: FAIL — cannot resolve `../src/player/reservations.js`.

- [ ] **Step 7: Write `src/player/reservations.ts`**

```typescript
import type { Play, SearchPlay } from '../api/schema.js';
import { RESERVATION_TTL_MS, URL_EXPIRY_MARGIN_SECONDS } from '../config.js';
import { urlExpiry } from '../url-expiry.js';

export interface Reservation {
  play: Play | SearchPlay;
  reservedAt: number;
  startedCountAtReserve: number;
}

/**
 * A reservation is usable when no other play has been started since it was
 * made — the condition the API spec names — and its audio URL has not expired.
 *
 * Expiry is read from the URL's `Expires` parameter where there is one. Where
 * there is not (stage serves unsigned URLs) we fall back to how long ago the
 * play was reserved, rather than assuming the worst and re-fetching forever.
 */
export function isReservationFresh(
  reservation: Reservation,
  playsStartedCount: number,
  nowMs: number,
): boolean {
  if (reservation.startedCountAtReserve !== playsStartedCount) return false;

  const url = reservation.play.audio_file.url;
  if (url === undefined) return false;

  switch (urlExpiry(url, URL_EXPIRY_MARGIN_SECONDS, nowMs)) {
    case 'valid':
      return true;
    case 'expired':
      return false;
    case 'unknown':
      return nowMs - reservation.reservedAt < RESERVATION_TTL_MS;
  }
}

export class ReservationStore {
  readonly #byStationUuid = new Map<string, Reservation>();

  put(uuid: string, reservation: Reservation): void {
    // Replacing simply drops the old one. An unused play needs no invalidate.
    this.#byStationUuid.set(uuid, reservation);
  }

  take(uuid: string): Reservation | undefined {
    const reservation = this.#byStationUuid.get(uuid);
    this.#byStationUuid.delete(uuid);
    return reservation;
  }

  discard(uuid: string): void {
    this.#byStationUuid.delete(uuid);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/reservations.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Commit**

```bash
git add src/player/stations.ts src/player/reservations.ts test/stations.test.ts test/reservations.test.ts
git commit -m "feat: add station records and reservation freshness rules"
```

---

### Task 7: Audio driver contract and test double

**Files:**
- Create: `src/audio/driver.ts`
- Create: `test/fake-audio-driver.ts`
- Test: `test/fake-audio-driver.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AudioEvent = 'ended' | 'timeupdate' | 'waiting' | 'playing' | 'error'`
  - `interface AudioDriver` with `loadCurrent(url: string, startAt?: number): void`, `loadStandby(url: string, startAt?: number): void`, `hasStandby(): boolean`, `promoteStandby(): void`, `play(): Promise<void>`, `pause(): void`, `stop(): void`, `unlock(): void`, `currentTime(): number`, `on(event: AudioEvent, handler: () => void): void`, `destroy(): void`
  - `class FakeAudioDriver implements AudioDriver` with test controls `fire(event)`, `setCurrentTime(seconds)`, `markStandbyReady()`, and inspection fields `currentUrl`, `standbyUrl`, `playCalls`, `pauseCalls`, `stopCalls`, `unlockCalls`

- [ ] **Step 1: Write `src/audio/driver.ts`**

```typescript
export type AudioEvent = 'ended' | 'timeupdate' | 'waiting' | 'playing' | 'error';

/**
 * The only abstraction over the DOM. Everything above it runs in node against
 * FakeAudioDriver, which is what makes the player's sequencing testable.
 */
export interface AudioDriver {
  /** Load into the element that is or will be playing. */
  loadCurrent(url: string, startAt?: number): void;

  /** Preload the next song into the standby element while the current plays. */
  loadStandby(url: string, startAt?: number): void;

  /** True only when the standby element has actually buffered, not merely been assigned a URL. */
  hasStandby(): boolean;

  /** Swap standby into current. This is how playback advances without a gap. */
  promoteStandby(): void;

  play(): Promise<void>;
  pause(): void;

  /** Pause and release both elements. */
  stop(): void;

  /**
   * Satisfy autoplay policy for both elements from within a user gesture. The
   * standby element has never been touched by one, so it needs this before it
   * can be promoted and played.
   */
  unlock(): void;

  currentTime(): number;
  on(event: AudioEvent, handler: () => void): void;
  destroy(): void;
}
```

- [ ] **Step 2: Write the failing test**

`test/fake-audio-driver.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { FakeAudioDriver } from './fake-audio-driver.js';

describe('FakeAudioDriver', () => {
  it('records loads and playback calls', async () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3', 12);
    await driver.play();

    expect(driver.currentUrl).toBe('https://cdn/a.mp3');
    expect(driver.currentTime()).toBe(12);
    expect(driver.playCalls).toBe(1);
  });

  it('reports no standby until it is marked ready', () => {
    const driver = new FakeAudioDriver();
    driver.loadStandby('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);

    driver.markStandbyReady();
    expect(driver.hasStandby()).toBe(true);
  });

  it('promotes standby into current and clears it', () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    driver.markStandbyReady();

    driver.promoteStandby();

    expect(driver.currentUrl).toBe('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);
  });

  it('delivers fired events to registered handlers', () => {
    const driver = new FakeAudioDriver();
    const onEnded = vi.fn();
    driver.on('ended', onEnded);

    driver.fire('ended');

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('resets position and urls on stop', () => {
    const driver = new FakeAudioDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.setCurrentTime(30);

    driver.stop();

    expect(driver.currentUrl).toBeUndefined();
    expect(driver.currentTime()).toBe(0);
    expect(driver.stopCalls).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/fake-audio-driver.test.ts`
Expected: FAIL — cannot resolve `./fake-audio-driver.js`.

- [ ] **Step 4: Write `test/fake-audio-driver.ts`**

```typescript
import type { AudioDriver, AudioEvent } from '../src/audio/driver.js';

export class FakeAudioDriver implements AudioDriver {
  currentUrl: string | undefined;
  standbyUrl: string | undefined;
  playCalls = 0;
  pauseCalls = 0;
  stopCalls = 0;
  unlockCalls = 0;

  /** Set this to make the next play() reject, simulating a load failure. */
  playRejection: Error | undefined;

  #time = 0;
  #standbyReady = false;
  readonly #handlers = new Map<AudioEvent, Set<() => void>>();

  loadCurrent(url: string, startAt = 0): void {
    this.currentUrl = url;
    this.#time = startAt;
  }

  loadStandby(url: string, _startAt = 0): void {
    this.standbyUrl = url;
    this.#standbyReady = false;
  }

  hasStandby(): boolean {
    return this.standbyUrl !== undefined && this.#standbyReady;
  }

  promoteStandby(): void {
    this.currentUrl = this.standbyUrl;
    this.standbyUrl = undefined;
    this.#standbyReady = false;
    this.#time = 0;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.playRejection !== undefined) {
      const rejection = this.playRejection;
      this.playRejection = undefined;
      throw rejection;
    }
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
    this.currentUrl = undefined;
    this.standbyUrl = undefined;
    this.#standbyReady = false;
    this.#time = 0;
  }

  unlock(): void {
    this.unlockCalls += 1;
  }

  currentTime(): number {
    return this.#time;
  }

  on(event: AudioEvent, handler: () => void): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
  }

  destroy(): void {
    this.#handlers.clear();
  }

  // --- test controls ---

  fire(event: AudioEvent): void {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) handler();
  }

  setCurrentTime(seconds: number): void {
    this.#time = seconds;
  }

  markStandbyReady(): void {
    this.#standbyReady = true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/fake-audio-driver.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/audio/driver.ts test/fake-audio-driver.ts test/fake-audio-driver.test.ts
git commit -m "feat: add AudioDriver contract and fake for tests"
```

---

### Task 8: HTML audio driver

**Files:**
- Create: `src/audio/html-audio.ts`
- Test: `test/html-audio.test.ts`

**Interfaces:**
- Consumes: `AudioDriver`, `AudioEvent` from Task 7.
- Produces: `class HtmlAudioDriver implements AudioDriver` with `constructor(options?: { createElement?: () => HTMLAudioElement })`.

- [ ] **Step 1: Write the failing test**

The element factory exists so this can be tested in node. `HAVE_CURRENT_DATA` is `readyState` 2.

`test/html-audio.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioDriver } from '../src/audio/html-audio.js';

class FakeElement {
  src = '';
  preload = '';
  currentTime = 0;
  readyState = 0;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, handler: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) { set = new Set(); this.listeners.set(type, set); }
    set.add(handler);
  }

  dispatch(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
  }
}

function makeDriver() {
  const elements: FakeElement[] = [];
  const driver = new HtmlAudioDriver({
    createElement: () => {
      const element = new FakeElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
  });
  return { driver, current: elements[0]!, standby: elements[1]! };
}

describe('HtmlAudioDriver', () => {
  it('creates two elements so the next song can preload', () => {
    const { current, standby } = makeDriver();
    expect(current).toBeDefined();
    expect(standby).toBeDefined();
  });

  it('loads a url into the current element and applies startAt', () => {
    const { driver, current } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3', 30);

    expect(current.src).toBe('https://cdn/a.mp3');
    current.dispatch('loadedmetadata');
    expect(current.currentTime).toBe(30);
  });

  it('preloads into the standby element', () => {
    const { driver, standby } = makeDriver();
    driver.loadStandby('https://cdn/b.mp3');

    expect(standby.src).toBe('https://cdn/b.mp3');
    expect(standby.preload).toBe('auto');
    expect(standby.load).toHaveBeenCalled();
  });

  // A standby that has a URL but no buffered data would stall on promotion.
  it('reports standby only once readyState reaches HAVE_CURRENT_DATA', () => {
    const { driver, standby } = makeDriver();
    driver.loadStandby('https://cdn/b.mp3');
    expect(driver.hasStandby()).toBe(false);

    standby.readyState = 2;
    expect(driver.hasStandby()).toBe(true);
  });

  it('swaps elements on promote so handlers follow the new current', async () => {
    const { driver, current, standby } = makeDriver();
    driver.loadCurrent('https://cdn/a.mp3');
    driver.loadStandby('https://cdn/b.mp3');
    standby.readyState = 2;

    driver.promoteStandby();
    await driver.play();

    expect(standby.play).toHaveBeenCalled();
    expect(current.play).not.toHaveBeenCalled();
  });

  it('unlock primes both elements so the standby can autoplay later', () => {
    const { driver, current, standby } = makeDriver();
    driver.unlock();

    expect(current.play).toHaveBeenCalled();
    expect(current.pause).toHaveBeenCalled();
    expect(standby.play).toHaveBeenCalled();
    expect(standby.pause).toHaveBeenCalled();
  });

  it('forwards ended, timeupdate, waiting, playing and error', () => {
    const { driver, current } = makeDriver();
    const handlers = {
      ended: vi.fn(), timeupdate: vi.fn(), waiting: vi.fn(), playing: vi.fn(), error: vi.fn(),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      driver.on(event as 'ended', handler);
    }

    for (const type of ['ended', 'timeupdate', 'waiting', 'playing', 'error']) current.dispatch(type);

    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('maps stalled onto waiting', () => {
    const { driver, current } = makeDriver();
    const onWaiting = vi.fn();
    driver.on('waiting', onWaiting);

    current.dispatch('stalled');

    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  // canplay fires when playback *could* start. Reporting a start then would
  // misreport the listen, so it must not surface as 'playing'.
  it('does not map canplay onto playing', () => {
    const { driver, current } = makeDriver();
    const onPlaying = vi.fn();
    driver.on('playing', onPlaying);

    current.dispatch('canplay');

    expect(onPlaying).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html-audio.test.ts`
Expected: FAIL — cannot resolve `../src/audio/html-audio.js`.

- [ ] **Step 3: Write `src/audio/html-audio.ts`**

```typescript
import type { AudioDriver, AudioEvent } from './driver.js';

/** HTMLMediaElement.HAVE_CURRENT_DATA */
const HAVE_CURRENT_DATA = 2;

const DOM_TO_AUDIO_EVENT: ReadonlyArray<readonly [string, AudioEvent]> = [
  ['ended', 'ended'],
  ['timeupdate', 'timeupdate'],
  ['waiting', 'waiting'],
  ['stalled', 'waiting'],
  ['playing', 'playing'],
  ['error', 'error'],
  // `canplay` is deliberately absent: it means playback *could* begin, not
  // that it has, and POST /play/{id}/start must report the real moment.
];

export interface HtmlAudioDriverOptions {
  createElement?: () => HTMLAudioElement;
}

export class HtmlAudioDriver implements AudioDriver {
  #current: HTMLAudioElement;
  #standby: HTMLAudioElement;

  readonly #handlers = new Map<AudioEvent, Set<() => void>>();

  constructor(options: HtmlAudioDriverOptions = {}) {
    const create = options.createElement ?? (() => new Audio());
    this.#current = create();
    this.#standby = create();

    // Listen on both, so a promotion needs no re-binding.
    for (const element of [this.#current, this.#standby]) this.#bind(element);
  }

  #bind(element: HTMLAudioElement): void {
    for (const [domEvent, audioEvent] of DOM_TO_AUDIO_EVENT) {
      element.addEventListener(domEvent, () => {
        // Only the element actually playing may speak for the player.
        if (element !== this.#current) return;
        for (const handler of [...(this.#handlers.get(audioEvent) ?? [])]) handler();
      });
    }
  }

  #load(element: HTMLAudioElement, url: string, startAt: number): void {
    element.src = url;
    element.preload = 'auto';
    if (startAt > 0) {
      element.addEventListener('loadedmetadata', () => { element.currentTime = startAt; }, { once: true });
    }
    element.load();
  }

  loadCurrent(url: string, startAt = 0): void {
    this.#load(this.#current, url, startAt);
  }

  loadStandby(url: string, startAt = 0): void {
    this.#load(this.#standby, url, startAt);
  }

  hasStandby(): boolean {
    return this.#standby.src !== '' && this.#standby.readyState >= HAVE_CURRENT_DATA;
  }

  promoteStandby(): void {
    const previous = this.#current;
    this.#current = this.#standby;
    this.#standby = previous;

    this.#standby.pause();
    this.#standby.removeAttribute('src');
  }

  async play(): Promise<void> {
    await this.#current.play();
  }

  pause(): void {
    this.#current.pause();
  }

  stop(): void {
    for (const element of [this.#current, this.#standby]) {
      element.pause();
      element.removeAttribute('src');
    }
  }

  /**
   * Autoplay policy is per element. The standby has never been touched by a
   * user gesture, so without this it refuses to play once promoted.
   */
  unlock(): void {
    for (const element of [this.#current, this.#standby]) {
      void Promise.resolve(element.play()).catch(() => undefined);
      element.pause();
    }
  }

  currentTime(): number {
    return this.#current.currentTime;
  }

  on(event: AudioEvent, handler: () => void): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
  }

  destroy(): void {
    this.stop();
    this.#handlers.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/html-audio.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audio/html-audio.ts test/html-audio.test.ts
git commit -m "feat: add two-element HTML audio driver"
```

---

### Task 9: Client id storage and connect()

**Files:**
- Create: `src/storage.ts`, `src/connect.ts`
- Test: `test/storage.test.ts`, `test/connect.test.ts`

**Interfaces:**
- Consumes: `FeedApiClient` (Tasks 3–4), `HtmlAudioDriver` (Task 8), `CLIENT_ID_STORAGE_PREFIX` (Task 1), `ConnectOptions`/`Player` (Task 5), `toStationRecord` (Task 6).
- Produces: `readStoredClientId(token: string): string | undefined`, `writeStoredClientId(token: string, clientId: string): void`, and `connect(options: ConnectOptions): Promise<Player>`.
- Note: `connect` constructs `PlayerImpl` from Task 10. Implement Task 10 first if executing strictly in order, or stub the import and let Task 10 satisfy it.

- [ ] **Step 1: Write the failing storage test**

`test/storage.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredClientId, writeStoredClientId } from '../src/storage.js';

function installStorage(impl: Partial<Storage>): void {
  vi.stubGlobal('localStorage', impl as Storage);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('client id storage', () => {
  it('scopes the key by token so two credential pairs do not collide', () => {
    const store = new Map<string, string>();
    installStorage({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
    });

    writeStoredClientId('tok-a', 'client-a');
    writeStoredClientId('tok-b', 'client-b');

    expect(store.get('feed.fm.client_id.tok-a')).toBe('client-a');
    expect(readStoredClientId('tok-a')).toBe('client-a');
    expect(readStoredClientId('tok-b')).toBe('client-b');
  });

  it('returns undefined when nothing is stored', () => {
    installStorage({ getItem: () => null, setItem: () => undefined });
    expect(readStoredClientId('tok')).toBeUndefined();
  });

  // Private browsing throws on access rather than returning null.
  it('survives a localStorage that throws on read', () => {
    installStorage({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => undefined,
    });
    expect(readStoredClientId('tok')).toBeUndefined();
  });

  it('survives a localStorage that throws on write', () => {
    installStorage({
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    });
    expect(() => writeStoredClientId('tok', 'client')).not.toThrow();
  });

  it('survives localStorage being absent entirely', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readStoredClientId('tok')).toBeUndefined();
    expect(() => writeStoredClientId('tok', 'client')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage.test.ts`
Expected: FAIL — cannot resolve `../src/storage.js`.

- [ ] **Step 3: Write `src/storage.ts`**

```typescript
import { CLIENT_ID_STORAGE_PREFIX } from './config.js';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Some browsers throw on the property access itself when site data is blocked.
    return undefined;
  }
}

export function readStoredClientId(token: string): string | undefined {
  try {
    return storage()?.getItem(`${CLIENT_ID_STORAGE_PREFIX}${token}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredClientId(token: string, clientId: string): void {
  try {
    storage()?.setItem(`${CLIENT_ID_STORAGE_PREFIX}${token}`, clientId);
  } catch {
    // A client id we cannot persist is not worth failing a session over.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/storage.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing connect test**

`test/connect.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../src/connect.js';
import { FeedError } from '../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const availableSession = {
  success: true,
  session: { available: true, client_id: 'minted-1', time: 1 },
  stations: [{
    id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null,
    options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x',
  }],
};

function installStorage(store = new Map<string, string>()) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  } as unknown as Storage);
  return store;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('connect', () => {
  it('sends no client_id on a first connect and persists the minted one', async () => {
    const store = installStorage();
    const fetchImpl = vi.fn(async () => jsonResponse(availableSession));

    const player = await connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({});
    expect(player.clientId()).toBe('minted-1');
    expect(store.get('feed.fm.client_id.tok')).toBe('minted-1');
  });

  it('reuses a client id from storage when none is passed', async () => {
    installStorage(new Map([['feed.fm.client_id.tok', 'stored-9']]));
    const fetchImpl = vi.fn(async () => jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_id: 'stored-9' });
  });

  it('prefers an explicit clientId over storage', async () => {
    installStorage(new Map([['feed.fm.client_id.tok', 'stored-9']]));
    const fetchImpl = vi.fn(async () => jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', clientId: 'explicit-3', fetchImpl } as never);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_id: 'explicit-3' });
  });

  // available:false arrives as HTTP 200 with success:true. Status alone is a lie.
  it('rejects when the session reports no music available', async () => {
    installStorage();
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      session: { available: false, client_id: 'c', time: 1, message: 'Sorry, no music' },
    }));

    const promise = connect({ token: 'tok', secret: 'sec', fetchImpl } as never);

    await expect(promise).rejects.toBeInstanceOf(FeedError);
    await expect(promise).rejects.toMatchObject({ message: 'Sorry, no music' });
  });

  it('rejects on bad credentials', async () => {
    installStorage();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, error: { code: 5, message: 'bad creds', status: 401 } }, 401),
    );

    await expect(connect({ token: 'tok', secret: 'sec', fetchImpl } as never))
      .rejects.toMatchObject({ code: 5 });
  });

  it('uses the supplied baseUrl', async () => {
    installStorage();
    const fetchImpl = vi.fn(async () => jsonResponse(availableSession));

    await connect({ token: 'tok', secret: 'sec', baseUrl: 'https://stage.feed.fm', fetchImpl } as never);

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://stage.feed.fm/api/v3/session');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/connect.test.ts`
Expected: FAIL — cannot resolve `../src/connect.js`.

- [ ] **Step 7: Write `src/connect.ts`**

`fetchImpl` is an internal seam for tests; it stays off the public `ConnectOptions` type.

```typescript
import { FeedApiClient } from './api/client.js';
import { HtmlAudioDriver } from './audio/html-audio.js';
import { ErrorCode, FeedError } from './errors.js';
import { PlayerImpl } from './player/player.js';
import { toStationRecord } from './player/stations.js';
import { readStoredClientId, writeStoredClientId } from './storage.js';
import type { ConnectOptions, Player } from './types.js';

interface InternalConnectOptions extends ConnectOptions {
  fetchImpl?: typeof fetch;
}

export async function connect(options: ConnectOptions): Promise<Player> {
  const { token, secret, baseUrl } = options;
  const { fetchImpl } = options as InternalConnectOptions;

  const client = new FeedApiClient({ token, secret, baseUrl, fetchImpl });

  const requestedClientId = options.clientId ?? readStoredClientId(token);
  const response = await client.startSession(requestedClientId);
  const session = response.session;

  if (!session.available) {
    throw new FeedError(
      ErrorCode.noMusic,
      session.message ?? 'No streaming music is available for this client',
      403,
    );
  }

  client.clientId = session.client_id;
  writeStoredClientId(token, session.client_id);

  return new PlayerImpl({
    client,
    driver: new HtmlAudioDriver(),
    clientId: session.client_id,
    stations: (response.stations ?? []).map(toStationRecord),
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/connect.test.ts`
Expected: PASS, 6 tests. (Requires Task 10's `PlayerImpl` to exist.)

- [ ] **Step 9: Commit**

```bash
git add src/storage.ts src/connect.ts test/storage.test.ts test/connect.test.ts
git commit -m "feat: add scoped client id storage and connect()"
```

---

### Task 10: Player skeleton and findStation

**Files:**
- Create: `src/player/player.ts`
- Test: `test/player-find-station.test.ts`, `test/player-harness.ts`

**Interfaces:**
- Consumes: `FeedApiClient`, `AudioDriver`, `Emitter`, `ReservationStore`, `isReservationFresh`, `toStationRecord`, `toPublicStation`, `StationRecord`, `FeedError`, `ErrorCode`, all public types.
- Produces:
  - `interface PlayerDeps { client: FeedApiClient; driver: AudioDriver; clientId: string; stations?: StationRecord[]; now?: () => number }`
  - `class PlayerImpl implements Player` — this task lands `clientId()`, `status()`, `buffering()`, `activeSong()`, `on()`, `off()`, `findStation()`. Later tasks add `play`, `pause`, `resume`, `skip`, `stop`.
  - `test/player-harness.ts` exporting `makePlayer()` returning `{ player, client, driver, events }`, reused by every later player test.

- [ ] **Step 1: Write the shared test harness**

`test/player-harness.ts`:

```typescript
import { vi } from 'vitest';
import { PlayerImpl } from '../src/player/player.js';
import type { ApiStation, Play, SearchPlay } from '../src/api/schema.js';
import type { FeedApiClient } from '../src/api/client.js';
import type { PlayerEvents } from '../src/types.js';
import { FakeAudioDriver } from './fake-audio-driver.js';

export const NOW = 1_800_000_000_000;

export function apiStation(overrides: Partial<ApiStation> = {}): ApiStation {
  return {
    id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null,
    options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x', ...overrides,
  };
}

export function makePlay(id: string, url = `https://cdn/${id}.mp3`): Play {
  return {
    id,
    audio_file: {
      id: `af-${id}`, duration_in_seconds: 180, codec: 'mp3', url,
      track: { id: 't', title: `Song ${id}` },
      release: { id: 'r', title: 'Album' },
      artist: { id: 'a', name: 'Artist' },
      extra: {},
    },
  };
}

export function makeSearchPlay(id: string, station = apiStation(), url?: string): SearchPlay {
  return { ...makePlay(id, url), station };
}

export function makePlayer(stations = [{ uuid: 'u-7', id: '7', name: 'Pop', options: {} }]) {
  const client = {
    clientId: 'cid',
    searchStation: vi.fn(),
    // Defaults resolve to a usable play so a test that does not care about the
    // next-song preload does not fail inside it.
    createPlay: vi.fn(async () => makePlay('default')),
    startPlay: vi.fn(async () => ({ canSkip: true, canLike: true })),
    elapsePlay: vi.fn(async () => undefined),
    skipPlay: vi.fn(async () => true),
    completePlay: vi.fn(async () => undefined),
    invalidatePlay: vi.fn(async () => undefined),
    post: vi.fn(),
  };

  const driver = new FakeAudioDriver();
  const events: Array<{ name: keyof PlayerEvents; arg?: unknown }> = [];

  const player = new PlayerImpl({
    client: client as unknown as FeedApiClient,
    driver,
    clientId: 'cid',
    stations,
    now: () => NOW,
  });

  const names: Array<keyof PlayerEvents> = [
    'play-started', 'play-elapsed', 'play-paused', 'play-stopped',
    'buffering-started', 'buffering-ended', 'error',
  ];
  for (const name of names) {
    player.on(name, ((arg: unknown) => { events.push({ name, arg }); }) as never);
  }

  const eventNames = () => events.map((e) => e.name);

  return { player, client, driver, events, eventNames };
}
```

- [ ] **Step 2: Write the failing test**

`test/player-find-station.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { FeedError } from '../src/errors.js';
import { apiStation, makePlayer, makeSearchPlay } from './player-harness.js';

describe('Player accessors', () => {
  it('reports the client id and starts stopped', () => {
    const { player } = makePlayer();
    expect(player.clientId()).toBe('cid');
    expect(player.status()).toBe('stopped');
    expect(player.buffering()).toBe(false);
    expect(player.activeSong()).toBeNull();
  });
});

describe('findStation', () => {
  it('searches by exact name and returns a uuid-addressed station', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ uuid: 'u-9', name: 'Chill' })));

    const station = await player.findStation('Chill');

    expect(client.searchStation).toHaveBeenCalledWith({ filter: { name: 'Chill' } });
    expect(station).toEqual({ uuid: 'u-9', name: 'Chill', options: {} });
  });

  it('never exposes the numeric station id', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ id: '33714093' })));

    const station = await player.findStation('Pop');

    expect(JSON.stringify(station)).not.toContain('33714093');
  });

  it('returns null when no station matches', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(17, 'No matching station was found', 404));

    await expect(player.findStation('Nope')).resolves.toBeNull();
  });

  it('returns null when the station has nothing playable', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(9, 'no more music', 200));
    await expect(player.findStation('Dry')).resolves.toBeNull();

    client.searchStation.mockRejectedValue(new FeedError(24, 'format unavailable', 200));
    await expect(player.findStation('Odd')).resolves.toBeNull();
  });

  it('rejects on a genuine failure', async () => {
    const { player, client } = makePlayer();
    client.searchStation.mockRejectedValue(new FeedError(22, 'throttled', 429));

    await expect(player.findStation('Pop')).rejects.toMatchObject({ code: 22 });
  });

  it('does not disturb playback state', async () => {
    const { player, client, eventNames } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('p1'));

    await player.findStation('Pop');

    expect(player.status()).toBe('stopped');
    expect(eventNames()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/player-find-station.test.ts`
Expected: FAIL — cannot resolve `../src/player/player.js`.

- [ ] **Step 4: Write `src/player/player.ts`**

```typescript
import type { FeedApiClient } from '../api/client.js';
import type { Play, SearchPlay } from '../api/schema.js';
import type { AudioDriver } from '../audio/driver.js';
import { ErrorCode, FeedError } from '../errors.js';
import type { Player, PlayerEvents, PlayerStatus, SongMetadata, Station, StopReason } from '../types.js';
import { Emitter } from './emitter.js';
import { ReservationStore, isReservationFresh } from './reservations.js';
import { toPublicStation, toStationRecord, type StationRecord } from './stations.js';

export interface PlayerDeps {
  client: FeedApiClient;
  driver: AudioDriver;
  clientId: string;
  stations?: StationRecord[];
  now?: () => number;
}

interface ActivePlay {
  play: Play | SearchPlay;
  started: boolean;
  canSkip: boolean;
}

/** A station that matched but has nothing playable is, to the caller, no station. */
const NOT_PLAYABLE = new Set<number>([
  ErrorCode.missingObject,
  ErrorCode.noMoreMusic,
  ErrorCode.formatUnavailable,
]);

export class PlayerImpl implements Player {
  readonly #client: FeedApiClient;
  readonly #driver: AudioDriver;
  readonly #clientId: string;
  readonly #now: () => number;

  readonly #emitter = new Emitter<PlayerEvents>();
  readonly #stations = new Map<string, StationRecord>();
  readonly #reservations = new ReservationStore();

  #status: PlayerStatus = 'stopped';
  #bufferingFlag = false;
  #activeStation: StationRecord | null = null;
  #activePlay: ActivePlay | null = null;
  #nextPlay: Play | null = null;

  #generation = 0;
  #playsStartedCount = 0;
  #consecutiveFailures = 0;
  #expiryRefetches = 0;

  constructor(deps: PlayerDeps) {
    this.#client = deps.client;
    this.#driver = deps.driver;
    this.#clientId = deps.clientId;
    this.#now = deps.now ?? (() => Date.now());

    for (const record of deps.stations ?? []) this.#stations.set(record.uuid, record);
  }

  clientId(): string {
    return this.#clientId;
  }

  status(): PlayerStatus {
    return this.#status;
  }

  buffering(): boolean {
    return this.#bufferingFlag;
  }

  activeSong(): SongMetadata | null {
    if (this.#activePlay === null) return null;
    const file = this.#activePlay.play.audio_file;
    return {
      title: file.track.title,
      artist: file.artist.name,
      release: file.release.title,
      durationInSeconds: file.duration_in_seconds,
      elapsedInSeconds: this.#driver.currentTime(),
    };
  }

  on<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void {
    this.#emitter.on(event, handler);
  }

  off<K extends keyof PlayerEvents>(event: K, handler: PlayerEvents[K]): void {
    this.#emitter.off(event, handler);
  }

  async findStation(query: string): Promise<Station | null> {
    try {
      const play = await this.#client.searchStation({ filter: { name: query } });
      return toPublicStation(this.#recordSearchResult(play));
    } catch (error) {
      if (error instanceof FeedError && NOT_PLAYABLE.has(error.code)) return null;
      throw error;
    }
  }

  /** Stores the station and the play the search reserved as a side effect. */
  #recordSearchResult(play: SearchPlay): StationRecord {
    const record = toStationRecord(play.station);
    this.#stations.set(record.uuid, record);
    this.#reservations.put(record.uuid, {
      play,
      reservedAt: this.#now(),
      startedCountAtReserve: this.#playsStartedCount,
    });
    return record;
  }

  #setBuffering(value: boolean): void {
    if (this.#bufferingFlag === value) return;
    this.#bufferingFlag = value;
    this.#emitter.emit(value ? 'buffering-started' : 'buffering-ended');
  }

  #emitError(error: unknown): void {
    this.#emitter.emit(
      'error',
      error instanceof FeedError
        ? error
        : new FeedError(ErrorCode.networkError, error instanceof Error ? error.message : 'unknown error', 0),
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/player-find-station.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/player/player.ts test/player-harness.ts test/player-find-station.test.ts
git commit -m "feat: add player skeleton and findStation"
```

---

### Task 11: Starting and stopping playback

**Files:**
- Modify: `src/player/player.ts`
- Test: `test/player-play-stop.test.ts`

**Interfaces:**
- Consumes: everything from Task 10; `ELAPSE_INTERVAL_MS`, `TICK_INTERVAL_MS` from config.
- Produces on `PlayerImpl`: `play(station: Station): void`, `stop(): void`, and internals `#startStation`, `#obtainPlay`, `#beginPlayback`, `#onAudioPlaying`, `#reserveNext`, `#startTimers`, `#stopTimers`, `#reportElapse`, `#teardown(reason: StopReason)`.

- [ ] **Step 1: Write the failing test**

`test/player-play-stop.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePlay, makePlayer, makeSearchPlay, apiStation } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Drives the fake driver through the events a real element would emit. */
async function beginPlayback(driver: { fire: (e: 'playing') => void }) {
  await vi.advanceTimersByTimeAsync(0);
  driver.fire('playing');
  await vi.advanceTimersByTimeAsync(0);
}

describe('play', () => {
  it('goes to playing and buffering immediately, before any network work', () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });

    expect(player.status()).toBe('playing');
    expect(player.buffering()).toBe(true);
    expect(driver.unlockCalls).toBe(1);
  });

  it('uses the play reserved by findStation instead of a new POST /play', async () => {
    const { player, client, driver } = makePlayer();
    client.searchStation.mockResolvedValue(makeSearchPlay('search-1'));
    const station = (await player.findStation('Pop'))!;

    player.play(station);
    await beginPlayback(driver);

    expect(client.createPlay).toHaveBeenCalledTimes(1); // the next-song preload only
    expect(driver.currentUrl).toBe('https://cdn/search-1.mp3');
  });

  it('reserves a play by station id when it has no fresh reservation', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(client.createPlay).toHaveBeenCalledWith('7');
    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
  });

  it('locates a station by uuid when it holds no internal record', async () => {
    const { player, client, driver } = makePlayer([]);
    client.searchStation.mockResolvedValue(makeSearchPlay('p1', apiStation({ uuid: 'u-x', id: '99' })));
    client.createPlay.mockResolvedValue(makePlay('p2'));

    player.play({ uuid: 'u-x', name: 'Elsewhere', options: {} });
    await beginPlayback(driver);

    expect(client.searchStation).toHaveBeenCalledWith({ filter: { uuid: 'u-x' } });
  });

  it('reports the start and clears buffering once audio really plays', async () => {
    const { player, client, driver, eventNames } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(client.startPlay).toHaveBeenCalledWith('p1');
    expect(player.buffering()).toBe(false);
    expect(eventNames()).toEqual(['buffering-started', 'buffering-ended', 'play-started']);
    expect(player.activeSong()).toMatchObject({ title: 'Song p1', artist: 'Artist', release: 'Album' });
  });

  it('preloads the next song right after reporting the start', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);

    expect(driver.standbyUrl).toBe('https://cdn/p2.mp3');
  });

  it('emits play-elapsed every second while playing', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    await vi.advanceTimersByTimeAsync(3000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(3);
  });

  it('reports elapsed time to the server every ten seconds', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    driver.setCurrentTime(10);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 10);
  });

  it('is a no-op when asked to play the station already playing', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));
    const station = { uuid: 'u-7', name: 'Pop', options: {} };

    player.play(station);
    await beginPlayback(driver);
    const callsBefore = client.createPlay.mock.calls.length;

    player.play(station);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createPlay.mock.calls.length).toBe(callsBefore);
  });
});

describe('stop', () => {
  it('reports elapsed, stops audio, and clears state', async () => {
    const { player, client, driver, eventNames } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    driver.setCurrentTime(42);
    player.stop();

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 42);
    expect(driver.stopCalls).toBe(1);
    expect(player.status()).toBe('stopped');
    expect(player.activeSong()).toBeNull();
    expect(eventNames().at(-1)).toBe('play-stopped');
  });

  // An unused play is discarded. Only a bad load ever invalidates.
  it('discards the preloaded next play without invalidating it', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
  });

  it('never completes a song the listener did not finish', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();

    expect(client.completePlay).not.toHaveBeenCalled();
  });

  it('is a no-op when already stopped', () => {
    const { player, driver, eventNames } = makePlayer();
    player.stop();
    expect(driver.stopCalls).toBe(0);
    expect(eventNames()).toEqual([]);
  });

  it('stops the elapsed timers', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await beginPlayback(driver);
    player.stop();
    const before = events.filter((e) => e.name === 'play-elapsed').length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/player-play-stop.test.ts`
Expected: FAIL — `player.play is not a function`.

- [ ] **Step 3: Add playback members to `src/player/player.ts`**

Add these imports:

```typescript
import { ELAPSE_INTERVAL_MS, TICK_INTERVAL_MS } from '../config.js';
```

Add these fields alongside the existing ones:

```typescript
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #elapseTimer: ReturnType<typeof setInterval> | undefined;
  #audioBound = false;
```

Add these members to the class:

```typescript
  play(station: Station): void {
    if (this.#activeStation?.uuid === station.uuid) {
      if (this.#status === 'paused') { this.resume(); return; }
      if (this.#status === 'playing') return;
    }
    void this.#startStation(station);
  }

  stop(): void {
    if (this.#status === 'stopped') return;
    this.#teardown('stopped-by-caller');
  }

  async #startStation(station: Station): Promise<void> {
    this.#bindAudio();
    if (this.#status !== 'stopped') this.#teardown('superseded');

    const generation = ++this.#generation;
    this.#activeStation =
      this.#stations.get(station.uuid) ??
      { uuid: station.uuid, id: '', name: station.name, options: station.options };
    this.#status = 'playing';
    this.#consecutiveFailures = 0;
    this.#expiryRefetches = 0;
    this.#setBuffering(true);
    this.#driver.unlock();

    try {
      const play = await this.#obtainPlay(station.uuid);
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      this.#failStart(error, generation);
    }
  }

  /**
   * A fresh reservation is used as-is. A stale one is simply dropped — an
   * unused play needs no invalidate — and replaced by a new reservation.
   */
  async #obtainPlay(uuid: string): Promise<Play | SearchPlay> {
    const reserved = this.#reservations.take(uuid);
    if (reserved !== undefined && isReservationFresh(reserved, this.#playsStartedCount, this.#now())) {
      return reserved.play;
    }

    const record = this.#stations.get(uuid);
    if (record !== undefined && record.id !== '') return this.#client.createPlay(record.id);

    // No internal record: uuid is the stable way to name one station.
    const play = await this.#client.searchStation({ filter: { uuid } });
    this.#activeStation = this.#recordSearchResult(play);
    this.#reservations.take(uuid);
    return play;
  }

  async #beginPlayback(play: Play | SearchPlay, generation: number): Promise<void> {
    const url = play.audio_file.url;
    if (url === undefined) {
      throw new FeedError(ErrorCode.networkError, 'play carried no audio url', 200);
    }

    this.#activePlay = { play, started: false, canSkip: false };
    this.#driver.loadCurrent(url, play.start_at ?? 0);

    try {
      await this.#driver.play();
    } catch (error) {
      if (generation === this.#generation) await this.#handleLoadFailure(play, generation);
    }
  }

  #bindAudio(): void {
    if (this.#audioBound) return;
    this.#audioBound = true;
    this.#driver.on('playing', () => { this.#onAudioPlaying(); });
    this.#driver.on('ended', () => { this.#onAudioEnded(); });
    this.#driver.on('waiting', () => { if (this.#status === 'playing') this.#setBuffering(true); });
    this.#driver.on('error', () => { this.#onAudioError(); });
  }

  /** Audio has genuinely started, so the listen may now be reported. */
  #onAudioPlaying(): void {
    const active = this.#activePlay;
    if (active === null) {
      return;
    }
    if (active.started) {
      this.#setBuffering(false);
      return;
    }

    active.started = true;
    this.#playsStartedCount += 1;
    this.#consecutiveFailures = 0;
    this.#expiryRefetches = 0;

    const generation = this.#generation;
    void this.#client
      .startPlay(active.play.id)
      .then((rights) => { if (generation === this.#generation) active.canSkip = rights.canSkip; })
      .catch((error: unknown) => { this.#emitError(error); });

    this.#setBuffering(false);
    this.#startTimers();

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-started', song);

    void this.#reserveNext(generation);
  }

  /** Retrieving audio is faster than playing it, so fetch the next song now. */
  async #reserveNext(generation: number): Promise<void> {
    const station = this.#activeStation;
    if (station === null || station.id === '') return;

    try {
      const play = await this.#client.createPlay(station.id);
      if (generation !== this.#generation) return;

      this.#nextPlay = play;
      if (play.audio_file.url !== undefined) {
        this.#driver.loadStandby(play.audio_file.url, play.start_at ?? 0);
      }
    } catch (error) {
      // Running dry is handled when we actually try to advance.
      if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) return;
      this.#emitError(error);
    }
  }

  #startTimers(): void {
    this.#stopTimers();
    this.#tickTimer = setInterval(() => {
      const song = this.activeSong();
      if (song !== null) this.#emitter.emit('play-elapsed', song);
    }, TICK_INTERVAL_MS);
    this.#elapseTimer = setInterval(() => {
      this.#reportElapse(this.#activePlay);
    }, ELAPSE_INTERVAL_MS);
  }

  #stopTimers(): void {
    if (this.#tickTimer !== undefined) clearInterval(this.#tickTimer);
    if (this.#elapseTimer !== undefined) clearInterval(this.#elapseTimer);
    this.#tickTimer = undefined;
    this.#elapseTimer = undefined;
  }

  #reportElapse(active: ActivePlay | null): void {
    if (active === null || !active.started) return;
    void this.#client
      .elapsePlay(active.play.id, this.#driver.currentTime())
      .catch((error: unknown) => { this.#emitError(error); });
  }

  #teardown(reason: StopReason): void {
    const active = this.#activePlay;
    const hadPlayback = active !== null || this.#activeStation !== null;

    this.#stopTimers();
    this.#reportElapse(active);
    this.#driver.stop();

    // Discarded, never invalidated: an unstarted play stays queued server-side.
    this.#nextPlay = null;
    this.#activePlay = null;
    this.#activeStation = null;
    this.#status = 'stopped';
    this.#setBuffering(false);
    this.#generation += 1;

    if (hadPlayback) this.#emitter.emit('play-stopped', { reason });
  }

  #failStart(error: unknown, generation: number): void {
    if (generation !== this.#generation) return;
    if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) {
      this.#teardown('ended');
      return;
    }
    this.#emitError(error);
    this.#teardown('error');
  }
```

Add temporary stubs so the file compiles; Tasks 12–14 replace them:

```typescript
  #onAudioEnded(): void { /* Task 12 */ }
  #onAudioError(): void { /* Task 14 */ }
  async #handleLoadFailure(_play: Play | SearchPlay, _generation: number): Promise<void> { /* Task 14 */ }
  pause(): void { /* Task 13 */ }
  resume(): void { /* Task 13 */ }
  async skip(): Promise<boolean> { return false; /* Task 13 */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/player-play-stop.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/player/player.ts test/player-play-stop.test.ts
git commit -m "feat: start and stop playback with reservation reuse and preloading"
```

---

### Task 12: Advancing between songs and running out of music

**Files:**
- Modify: `src/player/player.ts`
- Test: `test/player-advance.test.ts`

**Interfaces:**
- Consumes: everything from Task 11.
- Produces on `PlayerImpl`: `#onAudioEnded()` (replacing the stub) and `#advance(generation: number, options: { complete: boolean }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`test/player-advance.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../src/errors.js';
import { makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

async function playFirstSong(harness: ReturnType<typeof makePlayer>) {
  harness.player.play({ uuid: 'u-7', name: 'Pop', options: {} });
  await settle();
  harness.driver.fire('playing');
  await settle();
}

describe('advancing when a song ends', () => {
  it('completes the finished play and promotes the preloaded next one', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValueOnce(makePlay('p2'));

    await playFirstSong(harness);
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();

    expect(client.completePlay).toHaveBeenCalledWith('p1');
    expect(driver.currentUrl).toBe('https://cdn/p2.mp3');
    expect(player.status()).toBe('playing');
  });

  it('reports the start of the promoted song and preloads another', async () => {
    const harness = makePlayer();
    const { client, driver, eventNames } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockResolvedValueOnce(makePlay('p2'))
      .mockResolvedValueOnce(makePlay('p3'));

    await playFirstSong(harness);
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();
    driver.fire('playing');
    await settle();

    expect(client.startPlay).toHaveBeenCalledWith('p2');
    expect(driver.standbyUrl).toBe('https://cdn/p3.mp3');
    expect(eventNames().filter((n) => n === 'play-started')).toHaveLength(2);
  });

  // A ready standby means no network wait, so there is nothing to report.
  it('does not emit buffering when the next song is already loaded', async () => {
    const harness = makePlayer();
    const { client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p2'));

    await playFirstSong(harness);
    const before = eventNames().length;
    driver.markStandbyReady();
    driver.fire('ended');
    await settle();

    expect(eventNames().slice(before)).not.toContain('buffering-started');
  });

  it('buffers and fetches when the standby has not loaded in time', async () => {
    const harness = makePlayer();
    const { player, client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p9'));

    await playFirstSong(harness);
    driver.fire('ended'); // standby never marked ready
    await settle();

    expect(player.buffering()).toBe(true);
    expect(eventNames()).toContain('buffering-started');
    expect(driver.currentUrl).toBe('https://cdn/p9.mp3');
  });
});

describe('running out of music', () => {
  it('stops cleanly with reason ended and emits no error', async () => {
    const harness = makePlayer();
    const { player, client, driver, events } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockRejectedValue(new FeedError(9, 'no more music', 200));

    await playFirstSong(harness);
    driver.fire('ended');
    await settle();

    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
    expect(events.at(-1)).toEqual({ name: 'play-stopped', arg: { reason: 'ended' } });
  });

  it('still completes the song that finished', async () => {
    const harness = makePlayer();
    const { client, driver } = harness;
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1'))
      .mockRejectedValue(new FeedError(9, 'no more music', 200));

    await playFirstSong(harness);
    driver.fire('ended');
    await settle();

    expect(client.completePlay).toHaveBeenCalledWith('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/player-advance.test.ts`
Expected: FAIL — the `ended` event does nothing, so `completePlay` is never called.

- [ ] **Step 3: Replace the `#onAudioEnded` stub in `src/player/player.ts`**

```typescript
  #onAudioEnded(): void {
    void this.#advance(this.#generation, { complete: true });
  }

  /**
   * Moves to the next song. `complete: false` is used after a granted skip,
   * which has already closed the play out server-side.
   */
  async #advance(generation: number, options: { complete: boolean }): Promise<void> {
    const finished = this.#activePlay;
    this.#stopTimers();

    if (finished !== null && options.complete) {
      void this.#client
        .completePlay(finished.play.id)
        .catch((error: unknown) => { this.#emitError(error); });
    }

    const next = this.#nextPlay;
    this.#nextPlay = null;

    // The happy path: the next song is already buffered, so there is no wait
    // and nothing to report as buffering.
    if (next !== null && this.#driver.hasStandby()) {
      this.#driver.promoteStandby();
      this.#activePlay = { play: next, started: false, canSkip: false };
      try {
        await this.#driver.play();
      } catch {
        if (generation === this.#generation) await this.#handleLoadFailure(next, generation);
      }
      return;
    }

    this.#setBuffering(true);

    const station = this.#activeStation;
    if (station === null) return;

    try {
      const play = next ?? (await this.#client.createPlay(station.id));
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      // The station is exhausted. That is the end of a station, not a failure.
      if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) {
        this.#teardown('ended');
        return;
      }
      this.#emitError(error);
      this.#teardown('error');
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/player-advance.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/player/player.ts test/player-advance.test.ts
git commit -m "feat: advance between songs and stop cleanly when music runs out"
```

---

### Task 13: Pause, resume and skip

**Files:**
- Modify: `src/player/player.ts`
- Test: `test/player-pause-skip.test.ts`

**Interfaces:**
- Consumes: everything from Task 12.
- Produces on `PlayerImpl`: `pause()`, `resume()`, `skip()` — all replacing their stubs.

- [ ] **Step 1: Write the failing test**

`test/player-pause-skip.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../src/errors.js';
import { makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

async function playing(harness: ReturnType<typeof makePlayer>) {
  harness.client.createPlay.mockResolvedValueOnce(makePlay('p1')).mockResolvedValue(makePlay('p2'));
  harness.player.play({ uuid: 'u-7', name: 'Pop', options: {} });
  await settle();
  harness.driver.fire('playing');
  await settle();
}

describe('pause and resume', () => {
  it('pauses audio, reports elapsed, and emits play-paused', async () => {
    const harness = makePlayer();
    const { player, client, driver, eventNames } = harness;
    await playing(harness);
    driver.setCurrentTime(25);

    player.pause();

    expect(player.status()).toBe('paused');
    expect(driver.pauseCalls).toBe(1);
    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 25);
    expect(eventNames().at(-1)).toBe('play-paused');
  });

  it('keeps the active song while paused', async () => {
    const harness = makePlayer();
    await playing(harness);
    harness.player.pause();

    expect(harness.player.activeSong()).toMatchObject({ title: 'Song p1' });
  });

  it('stops the elapsed ticks while paused', async () => {
    const harness = makePlayer();
    const { player, events } = harness;
    await playing(harness);
    player.pause();
    const before = events.filter((e) => e.name === 'play-elapsed').length;

    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.name === 'play-elapsed')).toHaveLength(before);
  });

  it('resume restarts audio and emits play-started', async () => {
    const harness = makePlayer();
    const { player, driver, eventNames } = harness;
    await playing(harness);
    const playsBefore = driver.playCalls;
    player.pause();

    player.resume();
    await settle();

    expect(player.status()).toBe('playing');
    expect(driver.playCalls).toBe(playsBefore + 1);
    expect(eventNames().at(-1)).toBe('play-started');
  });

  it('play() on the paused station resumes rather than restarting', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    player.pause();
    const callsBefore = client.createPlay.mock.calls.length;

    player.play({ uuid: 'u-7', name: 'Pop', options: {} });
    await settle();

    expect(player.status()).toBe('playing');
    expect(client.createPlay.mock.calls.length).toBe(callsBefore);
    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
  });

  it('resume does nothing after stop', async () => {
    const harness = makePlayer();
    const { player } = harness;
    await playing(harness);
    player.stop();

    player.resume();

    expect(player.status()).toBe('stopped');
    expect(player.activeSong()).toBeNull();
  });

  it('pause does nothing when not playing', () => {
    const { player, driver } = makePlayer();
    player.pause();
    expect(driver.pauseCalls).toBe(0);
  });
});

describe('skip', () => {
  it('asks the server with the elapsed position and advances when granted', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    driver.setCurrentTime(18);
    driver.markStandbyReady();

    await expect(player.skip()).resolves.toBe(true);

    expect(client.skipPlay).toHaveBeenCalledWith('p1', 18);
    expect(driver.currentUrl).toBe('https://cdn/p2.mp3');
  });

  // The skip already closed the play out; completing it too would be a lie.
  it('does not complete the skipped play', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    driver.markStandbyReady();

    await player.skip();

    expect(client.completePlay).not.toHaveBeenCalled();
  });

  // Licensing: stopping a song without a granted skip can get credentials revoked.
  it('keeps playing the current song when the skip is denied', async () => {
    const harness = makePlayer();
    const { player, client, driver } = harness;
    await playing(harness);
    client.skipPlay.mockResolvedValue(false);

    await expect(player.skip()).resolves.toBe(false);

    expect(driver.currentUrl).toBe('https://cdn/p1.mp3');
    expect(player.status()).toBe('playing');
    expect(player.activeSong()).toMatchObject({ title: 'Song p1' });
  });

  it('emits no error for a denied skip', async () => {
    const harness = makePlayer();
    const { player, client, events } = harness;
    await playing(harness);
    client.skipPlay.mockResolvedValue(false);

    await player.skip();

    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
  });

  it('resolves false and emits error when the skip request itself fails', async () => {
    const harness = makePlayer();
    const { player, client, events } = harness;
    await playing(harness);
    client.skipPlay.mockRejectedValue(new FeedError(22, 'throttled', 429));

    await expect(player.skip()).resolves.toBe(false);
    expect(events.filter((e) => e.name === 'error')).toHaveLength(1);
  });

  it('resolves false when nothing is playing', async () => {
    const { player, client } = makePlayer();
    await expect(player.skip()).resolves.toBe(false);
    expect(client.skipPlay).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/player-pause-skip.test.ts`
Expected: FAIL — `pause` is a stub, so status never changes.

- [ ] **Step 3: Replace the `pause`, `resume` and `skip` stubs**

```typescript
  pause(): void {
    const active = this.#activePlay;
    if (this.#status !== 'playing' || active === null) return;

    this.#driver.pause();
    this.#stopTimers();
    this.#status = 'paused';
    this.#setBuffering(false);
    this.#reportElapse(active);

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-paused', song);
  }

  resume(): void {
    if (this.#status !== 'paused' || this.#activePlay === null) return;

    this.#status = 'playing';
    void this.#driver.play().catch((error: unknown) => { this.#emitError(error); });
    this.#startTimers();

    const song = this.activeSong();
    if (song !== null) this.#emitter.emit('play-started', song);
  }

  /**
   * The server decides. A `false` here means keep playing: ending the song
   * anyway would breach the licensing protocol.
   */
  async skip(): Promise<boolean> {
    const active = this.#activePlay;
    if (active === null || !active.started) return false;

    const generation = this.#generation;

    try {
      const granted = await this.#client.skipPlay(active.play.id, this.#driver.currentTime());
      if (!granted) return false;
      if (generation !== this.#generation) return true;

      await this.#advance(generation, { complete: false });
      return true;
    } catch (error) {
      this.#emitError(error);
      return false;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/player-pause-skip.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/player/player.ts test/player-pause-skip.test.ts
git commit -m "feat: add pause, resume and server-authorized skip"
```

---

### Task 14: Failure recovery and the generation guard

**Files:**
- Modify: `src/player/player.ts`
- Test: `test/player-recovery.test.ts`

**Interfaces:**
- Consumes: everything from Task 13; `urlExpiry` from Task 2; `MAX_CONSECUTIVE_PLAY_FAILURES`, `MAX_EXPIRY_REFETCHES`, `URL_EXPIRY_MARGIN_SECONDS` from config.
- Produces on `PlayerImpl`: `#onAudioError()` and `#handleLoadFailure(play, generation)` replacing their stubs, plus `#retryWithFreshPlay(generation)`.

- [ ] **Step 1: Write the failing test**

`test/player-recovery.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedError } from '../src/errors.js';
import { NOW, makePlay, makePlayer } from './player-harness.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function settle() { await vi.advanceTimersByTimeAsync(0); }

const expiredUrl = `https://cdn/old.mp3?Expires=${NOW / 1000 - 60}&Signature=s`;
const validUrl = `https://cdn/good.mp3?Expires=${NOW / 1000 + 600}&Signature=s`;

const POP = { uuid: 'u-7', name: 'Pop', options: {} };

describe('expired audio URLs', () => {
  // An expired signature does not mean a bad song. POST /play re-signs it.
  it('re-fetches without invalidating when the URL has expired', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('p1', expiredUrl))
      .mockResolvedValue(makePlay('p1', validUrl));
    driver.playRejection = new Error('load failed');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(driver.currentUrl).toBe(validUrl);
  });

  it('gives up re-fetching after MAX_EXPIRY_REFETCHES', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('p1', expiredUrl));
    driver.playRejection = new Error('load failed');

    player.play(POP);
    for (let i = 0; i < 6; i += 1) {
      driver.playRejection = new Error('load failed');
      await settle();
    }

    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error').length).toBeGreaterThan(0);
  });

  it('discards a reservation whose URL expired and fetches a fresh play', async () => {
    const { player, client, driver } = makePlayer();
    client.searchStation.mockResolvedValue({
      ...makePlay('search-1', expiredUrl),
      station: { id: '7', uuid: 'u-7', name: 'Pop', on_demand: 0, pre_gain: null, options: {}, crossfade_seconds: 0, single_play: 0, last_updated: 'x' },
    });
    client.createPlay.mockResolvedValue(makePlay('fresh', validUrl));

    const station = (await player.findStation('Pop'))!;
    player.play(station);
    await settle();

    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(client.createPlay).toHaveBeenCalledWith('7');
    expect(driver.currentUrl).toBe(validUrl);
  });
});

describe('genuinely bad audio', () => {
  // Without invalidate, POST /play hands back the same broken play forever.
  it('invalidates a play whose URL is still valid but will not load', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', validUrl))
      .mockResolvedValue(makePlay('good', validUrl));
    driver.playRejection = new Error('decode error');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
    expect(driver.currentUrl).toBe(validUrl);
  });

  it('invalidates when the URL carries no Expires at all', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', 'https://cdn/bad.mp3'))
      .mockResolvedValue(makePlay('good', 'https://cdn/good.mp3'));
    driver.playRejection = new Error('decode error');

    player.play(POP);
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
  });

  it('stops with an error after three consecutive failures', async () => {
    const { player, client, driver, events } = makePlayer();
    client.createPlay.mockResolvedValue(makePlay('bad', validUrl));

    player.play(POP);
    for (let i = 0; i < 4; i += 1) {
      driver.playRejection = new Error('decode error');
      await settle();
    }

    expect(player.status()).toBe('stopped');
    expect(events.filter((e) => e.name === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ name: 'play-stopped', arg: { reason: 'error' } });
  });

  it('surfaces a driver error event as a load failure', async () => {
    const { player, client, driver } = makePlayer();
    client.createPlay
      .mockResolvedValueOnce(makePlay('bad', validUrl))
      .mockResolvedValue(makePlay('good', validUrl));

    player.play(POP);
    await settle();
    driver.fire('error');
    await settle();

    expect(client.invalidatePlay).toHaveBeenCalledWith('bad', expect.any(String));
  });
});

describe('single stream guarantee', () => {
  it('drops a late response from a superseded play()', async () => {
    const { player, client, driver } = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);

    let releaseSlow: (play: unknown) => void = () => {};
    client.createPlay
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve; }))
      .mockResolvedValue(makePlay('rock-1'));

    player.play(POP);
    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    releaseSlow(makePlay('pop-1'));
    await settle();

    expect(driver.currentUrl).toBe('https://cdn/rock-1.mp3');
  });

  it('reports elapsed and emits superseded when switching stations mid-song', async () => {
    const harness = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);
    const { player, client, driver, eventNames } = harness;
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play(POP);
    await settle();
    driver.fire('playing');
    await settle();
    driver.setCurrentTime(33);

    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    expect(client.elapsePlay).toHaveBeenCalledWith('p1', 33);
    expect(client.invalidatePlay).not.toHaveBeenCalled();
    expect(eventNames()).toContain('play-stopped');
  });

  it('never completes the outgoing song when switching stations', async () => {
    const harness = makePlayer([
      { uuid: 'u-7', id: '7', name: 'Pop', options: {} },
      { uuid: 'u-8', id: '8', name: 'Rock', options: {} },
    ]);
    const { player, client, driver } = harness;
    client.createPlay.mockResolvedValue(makePlay('p1'));

    player.play(POP);
    await settle();
    driver.fire('playing');
    await settle();
    player.play({ uuid: 'u-8', name: 'Rock', options: {} });
    await settle();

    expect(client.completePlay).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/player-recovery.test.ts`
Expected: FAIL — `#handleLoadFailure` is a stub, so nothing recovers.

- [ ] **Step 3: Replace the recovery stubs in `src/player/player.ts`**

Add these imports:

```typescript
import {
  MAX_CONSECUTIVE_PLAY_FAILURES,
  MAX_EXPIRY_REFETCHES,
  URL_EXPIRY_MARGIN_SECONDS,
} from '../config.js';
import { urlExpiry } from '../url-expiry.js';
```

Replace the stubs with:

```typescript
  #onAudioError(): void {
    const active = this.#activePlay;
    if (active === null) return;
    void this.#handleLoadFailure(active.play, this.#generation);
  }

  /**
   * Two very different failures arrive here, and the URL says which.
   *
   * An expired signature means the song is fine — POST /play re-signs it — so
   * the play is discarded and re-fetched, with no invalidate.
   *
   * Anything else means the file itself is unplayable, and invalidate is the
   * only way to stop POST /play handing back the identical broken play.
   */
  async #handleLoadFailure(play: Play | SearchPlay, generation: number): Promise<void> {
    if (generation !== this.#generation) return;

    const url = play.audio_file.url;
    const expiry = url === undefined
      ? 'unknown'
      : urlExpiry(url, URL_EXPIRY_MARGIN_SECONDS, this.#now());

    if (expiry === 'expired') {
      if (this.#expiryRefetches >= MAX_EXPIRY_REFETCHES) {
        this.#emitError(new FeedError(ErrorCode.networkError, 'audio url kept arriving expired', 0));
        this.#teardown('error');
        return;
      }
      this.#expiryRefetches += 1;
      await this.#retryWithFreshPlay(generation);
      return;
    }

    this.#consecutiveFailures += 1;
    void this.#client
      .invalidatePlay(play.id, 'audio failed to load')
      .catch(() => undefined);

    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_PLAY_FAILURES) {
      this.#emitError(new FeedError(ErrorCode.networkError, 'audio repeatedly failed to load', 0));
      this.#teardown('error');
      return;
    }

    await this.#retryWithFreshPlay(generation);
  }

  async #retryWithFreshPlay(generation: number): Promise<void> {
    const station = this.#activeStation;
    if (station === null || station.id === '') return;

    this.#setBuffering(true);

    try {
      const play = await this.#client.createPlay(station.id);
      if (generation !== this.#generation) return;
      await this.#beginPlayback(play, generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof FeedError && error.code === ErrorCode.noMoreMusic) {
        this.#teardown('ended');
        return;
      }
      this.#emitError(error);
      this.#teardown('error');
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/player-recovery.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole unit suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all suites PASS and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/player/player.ts test/player-recovery.test.ts
git commit -m "feat: recover from expired urls and bad audio, guard single stream"
```

---

### Task 15: Public entry point, README, and build

**Files:**
- Create: `src/index.ts`, `README.md`
- Test: `test/public-api.test.ts`

**Interfaces:**
- Consumes: `connect` from Task 9; all public types from Task 5; `FeedError` from Task 1.
- Produces: the package's public surface — `connect` and the exported types.

- [ ] **Step 1: Write the failing test**

`test/public-api.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

describe('public surface', () => {
  it('exports connect as the single entry point', () => {
    expect(typeof sdk.connect).toBe('function');
  });

  it('exports FeedError so callers can branch on error codes', () => {
    expect(typeof sdk.FeedError).toBe('function');
    expect(sdk.ErrorCode.noMoreMusic).toBe(9);
  });

  // Everything else is internal. Leaking the client or the driver would let a
  // caller start a second stream behind the player's back.
  it('exports nothing else at runtime', () => {
    expect(Object.keys(sdk).sort()).toEqual(['ErrorCode', 'FeedError', 'connect']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/public-api.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write `src/index.ts`**

```typescript
export { connect } from './connect.js';
export { ErrorCode, FeedError } from './errors.js';

export type {
  ConnectOptions,
  Player,
  PlayerEvents,
  PlayerStatus,
  SongMetadata,
  Station,
  StopReason,
} from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/public-api.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `README.md`**

````markdown
# feed-sample-client

A browser SDK for playing music from Feed.fm. Start a session, find a station
by name, play it.

```bash
npm install feed-sample-client
```

## Usage

```typescript
import { connect } from 'feed-sample-client';

const player = await connect({ token: 'demo', secret: 'demo' });

player.on('play-started', (song) => {
  console.log(`${song.title} — ${song.artist}`);
});

// Call play() from a click handler: browsers only allow audio to start
// from a user gesture.
document.querySelector('#play')!.addEventListener('click', async () => {
  const station = await player.findStation('Station One');
  if (station !== null) player.play(station);
});
```

## connect(options)

| Option | Required | Meaning |
| --- | --- | --- |
| `token` | yes | Your Feed.fm token |
| `secret` | yes | Your Feed.fm secret |
| `clientId` | no | Reuse a known listener. Falls back to `localStorage`, then to a server-minted id |
| `baseUrl` | no | Defaults to `https://feed.fm`. Use `https://stage.feed.fm` for staging |

Rejects with a `FeedError` if the credentials are refused or the client has no
music available.

## Player

| Method | Returns | Notes |
| --- | --- | --- |
| `clientId()` | `string` | The listener id this session is bound to |
| `status()` | `'stopped' \| 'playing' \| 'paused'` | `'playing'` from the moment `play()` is called |
| `buffering()` | `boolean` | Playing, but waiting on the network |
| `activeSong()` | `SongMetadata \| null` | Title, artist, release, duration, elapsed |
| `findStation(query)` | `Promise<Station \| null>` | Exact name match; `null` when nothing playable matches |
| `play(station)` | `void` | Stops any other station first. Resumes if this station is paused |
| `pause()` / `resume()` | `void` | |
| `skip()` | `Promise<boolean>` | `false` when the server denies the skip; playback continues |
| `stop()` | `void` | After this, `resume()` does nothing — call `play()` again |

Stations are identified by `uuid`. `name` is display text and may be edited.

## Events

```typescript
player.on('play-started',      (song) => {});  // started or resumed
player.on('play-elapsed',      (song) => {});  // once per second
player.on('play-paused',       (song) => {});
player.on('play-stopped',      ({ reason }) => {});  // 'ended' | 'stopped-by-caller' | 'superseded' | 'error'
player.on('buffering-started', () => {});
player.on('buffering-ended',   () => {});
player.on('error',             (err) => {});   // FeedError
```

A station running out of music emits `play-stopped` with reason `'ended'`, not
an `error`.

## Notes

- One `Player` plays one station at a time. `play()` on a new station stops the
  current one.
- Playback reporting is a licensing requirement. The SDK reports starts,
  completions and elapsed time on your behalf; a denied skip never stops the
  current song.
- `connect` takes a consumer token and secret, which ships the secret to the
  browser. For production, mint a short-lived pair with `POST /access_token`
  server-side and pass that instead — it uses the same scheme, so nothing else
  changes.
````

- [ ] **Step 6: Verify the build produces all three outputs**

Run: `npm run build && ls dist`
Expected: `index.js`, `index.cjs`, `index.d.ts` present.

Run: `node -e "import('./dist/index.js').then(m => console.log(typeof m.connect))"`
Expected: prints `function`.

- [ ] **Step 7: Confirm there are no runtime dependencies**

Run: `node -e "const p=require('./package.json'); if (p.dependencies && Object.keys(p.dependencies).length) { throw new Error('runtime deps: ' + Object.keys(p.dependencies)); } console.log('no runtime dependencies');"`
Expected: prints `no runtime dependencies`.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts README.md test/public-api.test.ts
git commit -m "feat: add public entry point and README"
```

---

### Task 16: Browser end-to-end tests against stage

**Files:**
- Create: `playwright.config.ts`, `e2e/harness/index.html`, `e2e/player.spec.ts`
- Modify: `package.json` (nothing new to install — `@playwright/test` is already a devDependency)

**Interfaces:**
- Consumes: the built `dist/index.js` from Task 15.
- Produces: an e2e suite exercising real audio and real network against `https://stage.feed.fm`.

Credentials, both public test values from the API docs:
- `counting:counting` — one station of very short numeric tracks, so a song completing is observable in seconds. Use it for completion and skip.
- `demo:demo` — a set of real radio stations. Use it for search.

- [ ] **Step 1: Write `playwright.config.ts`**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx http-server e2e/harness -p 5175 -c-1 --silent',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
});
```

- [ ] **Step 2: Write `e2e/harness/index.html`**

The page records every event and every SDK request so the tests can assert on
both. `play()` runs from a real click, since autoplay policy requires the gesture.

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>feed-sample-client harness</title></head>
  <body>
    <button id="connect">connect</button>
    <button id="play">play</button>
    <button id="pause">pause</button>
    <button id="resume">resume</button>
    <button id="skip">skip</button>
    <button id="stop">stop</button>
    <pre id="log"></pre>

    <script type="module">
      import { connect } from '../../dist/index.js';

      const params = new URLSearchParams(location.search);
      const token = params.get('token') ?? 'counting';
      const secret = params.get('secret') ?? 'counting';
      const stationName = params.get('station') ?? '';

      window.events = [];
      window.requests = [];
      window.player = null;
      window.station = null;

      // Record every SDK call so a test can prove complete/start/elapse fired.
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/api/v3/')) window.requests.push(url);
        return realFetch(input, init);
      };

      const log = (line) => {
        document.querySelector('#log').textContent += line + '\n';
      };

      document.querySelector('#connect').addEventListener('click', async () => {
        try {
          const player = await connect({ token, secret, baseUrl: 'https://stage.feed.fm' });
          window.player = player;

          for (const name of [
            'play-started', 'play-elapsed', 'play-paused', 'play-stopped',
            'buffering-started', 'buffering-ended', 'error',
          ]) {
            player.on(name, (arg) => {
              window.events.push({ name, arg: arg ?? null });
              log(name);
            });
          }
          window.connected = true;
        } catch (error) {
          window.connectError = error.message;
          log('connect failed: ' + error.message);
        }
      });

      document.querySelector('#play').addEventListener('click', async () => {
        const station = stationName === ''
          ? await window.player.findStation('')
          : await window.player.findStation(stationName);
        window.station = station;
        if (station !== null) window.player.play(station);
      });

      document.querySelector('#pause').addEventListener('click', () => window.player.pause());
      document.querySelector('#resume').addEventListener('click', () => window.player.resume());
      document.querySelector('#stop').addEventListener('click', () => window.player.stop());
      document.querySelector('#skip').addEventListener('click', async () => {
        window.skipResult = await window.player.skip();
        log('skip -> ' + window.skipResult);
      });
    </script>
  </body>
</html>
```

Note: `findStation('')` searches for a station literally named empty string,
which matches nothing. The counting-credentials tests pass an explicit
`?station=` value read from the live session — see Step 3.

- [ ] **Step 3: Write `e2e/player.spec.ts`**

```typescript
import { expect, test, type Page } from '@playwright/test';

const STAGE = 'https://stage.feed.fm/api/v3';

/** Ask the API which stations these credentials actually have. */
async function firstStationName(token: string, secret: string): Promise<string> {
  const auth = Buffer.from(`${token}:${secret}`).toString('base64');
  const session = await fetch(`${STAGE}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: '{}',
  }).then((r) => r.json());

  const name = session.stations?.[0]?.name;
  expect(name, 'stage returned no stations for these credentials').toBeTruthy();
  return name as string;
}

async function events(page: Page) {
  return page.evaluate(() => (window as never as { events: Array<{ name: string; arg: unknown }> }).events);
}

async function requests(page: Page) {
  return page.evaluate(() => (window as never as { requests: string[] }).requests);
}

async function connectAndPlay(page: Page, token: string, secret: string, station: string) {
  await page.goto(`/?token=${token}&secret=${secret}&station=${encodeURIComponent(station)}`);
  await page.click('#connect');
  await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);
  await page.click('#play');
}

test.describe('counting credentials — short tracks', () => {
  let station: string;
  test.beforeAll(async () => { station = await firstStationName('counting', 'counting'); });

  test('connects and persists the client id', async ({ page }) => {
    await page.goto(`/?token=counting&secret=counting&station=${encodeURIComponent(station)}`);
    await page.click('#connect');
    await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);

    const clientId = await page.evaluate(() =>
      (window as never as { player: { clientId(): string } }).player.clientId());
    expect(clientId).toBeTruthy();

    const stored = await page.evaluate(() => localStorage.getItem('feed.fm.client_id.counting'));
    expect(stored).toBe(clientId);
  });

  test('starts playback and reports the start to the server', async ({ page }) => {
    await connectAndPlay(page, 'counting', 'counting', station);

    await page.waitForFunction(() =>
      (window as never as { events: Array<{ name: string }> }).events.some((e) => e.name === 'play-started'),
      undefined, { timeout: 30_000 });

    expect(await page.evaluate(() =>
      (window as never as { player: { status(): string } }).player.status())).toBe('playing');
    expect((await requests(page)).some((u) => /\/play\/\d+\/start$/.test(u))).toBe(true);
  });

  test('completes a track and advances to the next', async ({ page }) => {
    await connectAndPlay(page, 'counting', 'counting', station);

    await page.waitForFunction(() =>
      (window as never as { events: Array<{ name: string }> }).events
        .filter((e) => e.name === 'play-started').length >= 2,
      undefined, { timeout: 45_000 });

    // A track that advanced without being reported complete is a licensing bug.
    expect((await requests(page)).some((u) => /\/play\/\d+\/complete$/.test(u))).toBe(true);
  });

  test('pauses, reports elapsed, and resumes', async ({ page }) => {
    await connectAndPlay(page, 'counting', 'counting', station);
    await page.waitForFunction(() =>
      (window as never as { events: Array<{ name: string }> }).events.some((e) => e.name === 'play-started'),
      undefined, { timeout: 30_000 });

    await page.click('#pause');
    await page.waitForFunction(() =>
      (window as never as { player: { status(): string } }).player.status() === 'paused');
    expect((await requests(page)).some((u) => /\/play\/\d+\/elapse$/.test(u))).toBe(true);

    await page.click('#resume');
    await page.waitForFunction(() =>
      (window as never as { player: { status(): string } }).player.status() === 'playing');
  });

  test('asks the server before skipping', async ({ page }) => {
    await connectAndPlay(page, 'counting', 'counting', station);
    await page.waitForFunction(() =>
      (window as never as { events: Array<{ name: string }> }).events.some((e) => e.name === 'play-started'),
      undefined, { timeout: 30_000 });

    await page.click('#skip');
    await page.waitForFunction(() =>
      (window as never as { skipResult?: boolean }).skipResult !== undefined);

    expect((await requests(page)).some((u) => /\/play\/\d+\/skip$/.test(u))).toBe(true);

    // Whatever the server decided, the player must still be coherent: a denied
    // skip keeps playing, a granted one keeps playing the next song.
    expect(await page.evaluate(() =>
      (window as never as { player: { status(): string } }).player.status())).toBe('playing');
  });

  test('stops and reports elapsed without completing', async ({ page }) => {
    await connectAndPlay(page, 'counting', 'counting', station);
    await page.waitForFunction(() =>
      (window as never as { events: Array<{ name: string }> }).events.some((e) => e.name === 'play-started'),
      undefined, { timeout: 30_000 });

    await page.click('#stop');

    expect(await page.evaluate(() =>
      (window as never as { player: { status(): string } }).player.status())).toBe('stopped');
    const stopped = (await events(page)).filter((e) => e.name === 'play-stopped');
    expect(stopped.at(-1)?.arg).toEqual({ reason: 'stopped-by-caller' });
  });
});

test.describe('demo credentials — station search', () => {
  let station: string;
  test.beforeAll(async () => { station = await firstStationName('demo', 'demo'); });

  test('finds a real station by name and exposes only its uuid', async ({ page }) => {
    await page.goto(`/?token=demo&secret=demo&station=${encodeURIComponent(station)}`);
    await page.click('#connect');
    await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);
    await page.click('#play');

    await page.waitForFunction(() => (window as never as { station?: unknown }).station !== null);
    const found = await page.evaluate(() => (window as never as { station: unknown }).station);

    expect(found).toMatchObject({ name: station });
    expect(Object.keys(found as object).sort()).toEqual(['name', 'options', 'uuid']);
  });

  test('returns null for a station that does not exist', async ({ page }) => {
    await page.goto('/?token=demo&secret=demo&station=NoSuchStationAnywhere');
    await page.click('#connect');
    await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);

    const result = await page.evaluate(async () =>
      (window as never as { player: { findStation(q: string): Promise<unknown> } })
        .player.findStation('NoSuchStationAnywhere'));

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 4: Add `http-server` for the harness**

Run: `npm install --save-dev http-server`

- [ ] **Step 5: Run the e2e suite**

Run: `npm run build && npx playwright install chromium && npm run test:e2e`
Expected: all tests PASS. These hit the live stage API, so a failure may be
stage being down rather than a code defect — check `curl -u counting:counting -X POST https://stage.feed.fm/api/v3/session -d '{}' -H 'Content-Type: application/json'` before debugging the SDK.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json
git commit -m "test: add browser e2e suite against stage"
```

---

## Done criteria

- [ ] `npx vitest run` — all unit suites pass
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run build` — `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` all present
- [ ] `npm run test:e2e` — browser suite passes against stage
- [ ] `package.json` has no `dependencies` block
- [ ] `grep -rn "X-Authorization" src/` returns nothing
- [ ] `grep -rn "invalidatePlay" src/` appears only in `api/client.ts` and inside `#handleLoadFailure`
