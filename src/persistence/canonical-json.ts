import { Buffer } from "node:buffer";

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class CanonicalJsonError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "CanonicalJsonError";
    this.reasonCode = reasonCode;
  }
}

export function canonicalSerialize(value: unknown): Buffer {
  return Buffer.from(serializeValue(value, new WeakSet<object>()), "utf8");
}

export function canonicalSerializeToUtf8(value: unknown): string {
  return canonicalSerialize(value).toString("utf8");
}

function serializeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "undefined":
      throw new CanonicalJsonError("UNDEFINED_VALUE");
    case "function":
      throw new CanonicalJsonError("FUNCTION_VALUE");
    case "symbol":
      throw new CanonicalJsonError("SYMBOL_VALUE");
    case "bigint":
      throw new CanonicalJsonError("BIGINT_VALUE");
    case "object":
      break;
    default:
      throw new CanonicalJsonError("UNSUPPORTED_TYPE");
  }

  if (seen.has(value)) {
    throw new CanonicalJsonError("CYCLIC_OBJECT");
  }
  seen.add(value);
  try {
    return Array.isArray(value) ? serializeArray(value, seen) : serializeObject(value, seen);
  } finally {
    seen.delete(value);
  }
}

function serializeNumber(value: number): string {
  if (Object.is(value, -0)) {
    throw new CanonicalJsonError("NEGATIVE_ZERO");
  }
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("NON_FINITE_NUMBER");
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalJsonError("UNSAFE_INTEGER");
  }
  return String(value);
}

function serializeArray(value: unknown[], seen: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }

  for (const key of Object.keys(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) {
      throw new CanonicalJsonError("NON_PLAIN_OBJECT");
    }
  }

  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new CanonicalJsonError("SPARSE_ARRAY");
    }
    parts.push(serializeValue(value[index], seen));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(value: object, seen: WeakSet<object>): string {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalJsonError("SYMBOL_VALUE");
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      throw new CanonicalJsonError("DANGEROUS_OBJECT_KEY");
    }
  }
  keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${serializeValue(record[key], seen)}`);
  }
  return `{${parts.join(",")}}`;
}
