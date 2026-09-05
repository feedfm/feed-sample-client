import { expect, test, type Page } from '@playwright/test';

const STAGE = 'https://stage.feed.fm/api/v3';

/** Ask the API which stations these credentials actually have. */
async function firstStationName(token: string, secret: string): Promise<string> {
  const auth = btoa(`${token}:${secret}`);
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
  await page.goto(`/e2e/harness/index.html?token=${token}&secret=${secret}&station=${encodeURIComponent(station)}`);
  await page.click('#connect');
  await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);
  await page.click('#play');
}

test.describe('counting credentials — short tracks', () => {
  let station: string;
  test.beforeAll(async () => { station = await firstStationName('counting', 'counting'); });

  test('connects and persists the client id', async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?token=counting&secret=counting&station=${encodeURIComponent(station)}`);
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

    // Mark the request stream here so the assertions below can be scoped to
    // exactly what `stop()` itself produces, not to anything an earlier play
    // in this session may have already completed.
    const requestsBeforeStop = (await requests(page)).length;

    await page.click('#stop');

    expect(await page.evaluate(() =>
      (window as never as { player: { status(): string } }).player.status())).toBe('stopped');
    const stopped = (await events(page)).filter((e) => e.name === 'play-stopped');
    expect(stopped.at(-1)?.arg).toEqual({ reason: 'stopped-by-caller' });

    const newRequests = (await requests(page)).slice(requestsBeforeStop);
    expect(newRequests.some((u) => /\/play\/\d+\/elapse$/.test(u))).toBe(true);
    expect(newRequests.some((u) => /\/play\/\d+\/complete$/.test(u))).toBe(false);
  });
});

test.describe('demo credentials — station search', () => {
  let station: string;
  test.beforeAll(async () => { station = await firstStationName('demo', 'demo'); });

  test('finds a real station by name and exposes only its uuid', async ({ page }) => {
    await page.goto(`/e2e/harness/index.html?token=demo&secret=demo&station=${encodeURIComponent(station)}`);
    await page.click('#connect');
    await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);
    await page.click('#play');

    await page.waitForFunction(() => (window as never as { station?: unknown }).station !== null);
    const found = await page.evaluate(() => (window as never as { station: unknown }).station);

    expect(found).toMatchObject({ name: station });
    expect(Object.keys(found as object).sort()).toEqual(['name', 'options', 'uuid']);
  });

  test('returns null for a station that does not exist', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?token=demo&secret=demo&station=NoSuchStationAnywhere');
    await page.click('#connect');
    await page.waitForFunction(() => (window as never as { connected?: boolean }).connected === true);

    const result = await page.evaluate(async () =>
      (window as never as { player: { findStation(q: string): Promise<unknown> } })
        .player.findStation('NoSuchStationAnywhere'));

    expect(result).toBeNull();
  });
});
