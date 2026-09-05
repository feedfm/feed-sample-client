import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedApiClient } from '../src/api/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const makeFetch = () =>
  vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    jsonResponse({ success: true }));

let fetchImpl: ReturnType<typeof makeFetch>;
let client: FeedApiClient;

beforeEach(() => {
  fetchImpl = makeFetch();
  client = new FeedApiClient({ token: 't', secret: 's', fetchImpl });
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
