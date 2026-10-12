export type LatchState = {
  blocked: boolean;
  reasonCodes: string[];
  blockedAt: string | null;
};

/**
 * Process-lifetime persistence-authority latch.
 * Once blocked, this instance cannot be cleared. A later successful disk write
 * must not unblock it. A fresh process must construct a new latch after a full
 * durable inspection. This is not trading authorization.
 */
export class RuntimePersistenceLatch {
  #blocked = false;
  #reasonCodes: string[] = [];
  #blockedAt: string | null = null;

  get blocked(): boolean {
    return this.#blocked;
  }

  get reasonCodes(): readonly string[] {
    return this.#reasonCodes;
  }

  get blockedAt(): string | null {
    return this.#blockedAt;
  }

  snapshot(): LatchState {
    return {
      blocked: this.#blocked,
      reasonCodes: [...this.#reasonCodes],
      blockedAt: this.#blockedAt,
    };
  }

  block(reasonCodes: readonly string[], blockedAt: string = new Date().toISOString()): void {
    if (this.#blocked) {
      this.#reasonCodes = uniquePreserveOrder([...this.#reasonCodes, ...reasonCodes]);
      return;
    }
    this.#blocked = true;
    this.#reasonCodes = uniquePreserveOrder(reasonCodes);
    this.#blockedAt = blockedAt;
  }
}

function uniquePreserveOrder(codes: readonly string[]): string[] {
  return [...new Set(codes)];
}
