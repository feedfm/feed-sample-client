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
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true }),
    );
    await makeClient(fetchImpl as unknown as typeof fetch).post('/status', {});

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe(`Basic ${btoa('tok:sec')}`);
    expect(headers.get('X-Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('appends /api/v3 and normalizes a trailing slash on baseUrl', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true }),
    );
    await makeClient(fetchImpl as unknown as typeof fetch, 'https://stage.feed.fm/').post('/session', {});

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://stage.feed.fm/api/v3/session');
  });

  it('defaults to production when no baseUrl is given', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true }),
    );
    await makeClient(fetchImpl as unknown as typeof fetch).post('/session', {});

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://feed.fm/api/v3/session');
  });

  it('includes client_id in the body once set', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    client.clientId = 'abc123';
    await client.post('/play', { station_id: '7' });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ station_id: '7', client_id: 'abc123' });
  });

  it('lets an explicit client_id in the body win over the instance field', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    client.clientId = 'instance-id';
    await client.post('/session', { client_id: 'explicit-id' });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_id: 'explicit-id' });
  });

  // The trap: codes 7, 9, 12 and 24 arrive with HTTP 200.
  it('throws FeedError on HTTP 200 with success:false', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: false, error: { code: 9, message: 'no more music', status: 200 } }),
    );
    const promise = makeClient(fetchImpl as unknown as typeof fetch).post('/play', {});

    await expect(promise).rejects.toBeInstanceOf(FeedError);
    await expect(promise).rejects.toMatchObject({ code: 9, mnemonic: 'noMoreMusic', status: 200 });
  });

  it('throws FeedError on an HTTP error carrying an envelope', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: false, error: { code: 5, message: 'bad creds', status: 401 } }, 401),
    );
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: 5, mnemonic: 'badCredentials', status: 401 });
  });

  it('throws a networkError FeedError when fetch rejects', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError('offline');
    });
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: -1, mnemonic: 'networkError' });
  });

  it('throws a networkError FeedError when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('<html>nope</html>', { status: 404 }),
    );
    await expect(makeClient(fetchImpl as unknown as typeof fetch).post('/session', {}))
      .rejects.toMatchObject({ code: -1, mnemonic: 'networkError', status: 404 });
  });

  it('returns the parsed body on success', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ success: true, play: { id: '1' } }),
    );
    const result = await makeClient(fetchImpl as unknown as typeof fetch).post<{ play: { id: string } }>('/play', {});
    expect(result.play.id).toBe('1');
  });
});
