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
