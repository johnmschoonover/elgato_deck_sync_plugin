/** Minimal logger contract; `streamDeck.logger` (and its scopes) satisfy it. */
export interface Log {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
