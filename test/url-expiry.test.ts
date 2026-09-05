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
