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
  /** Not from the API: the response parsed, but carried data we cannot act on. */
  malformedResponse: -2,
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
