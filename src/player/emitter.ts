type AnyHandler = (...args: never[]) => void;

export class Emitter<E extends Record<string, AnyHandler>> {
  readonly #handlers = new Map<keyof E, Set<AnyHandler>>();

  on<K extends keyof E>(event: K, handler: E[K]): void {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
  }

  off<K extends keyof E>(event: K, handler: E[K]): void {
    this.#handlers.get(event)?.delete(handler as AnyHandler);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.#handlers.get(event);
    if (set === undefined) return;

    // Copy first: a handler may add or remove handlers while we iterate.
    for (const handler of [...set]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch {
        // A consumer's bug must not break the player or starve later handlers.
      }
    }
  }
}
