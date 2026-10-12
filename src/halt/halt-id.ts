import { randomBytes } from "node:crypto";

export const HALT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;

export type HaltIdSource = {
  nextHaltId(): string;
};

export function isWellFormedHaltId(value: string): boolean {
  return HALT_ID_PATTERN.test(value);
}

export function createCryptoHaltIdSource(): HaltIdSource {
  return {
    nextHaltId() {
      return `h${randomBytes(16).toString("hex")}`;
    },
  };
}

export function createSequentialHaltIdSource(prefix = "h"): HaltIdSource {
  let sequence = 0;
  return {
    nextHaltId() {
      sequence += 1;
      return `${prefix}${sequence.toString(10)}`;
    },
  };
}
