import { DEFAULT_BASE_URL } from '../config.js';
import { ErrorCode, FeedError } from '../errors.js';
import type { FeedErrorBody } from './schema.js';
import type { Play, SearchPlay, SessionResponse, StationSearchQuery } from './schema.js';

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
}
