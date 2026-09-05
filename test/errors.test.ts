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
