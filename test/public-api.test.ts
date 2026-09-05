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
