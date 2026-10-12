import { Buffer } from "node:buffer";

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Own-property descriptors are the authority. Object.keys() is not a complete own-property set.
// Arbitrary malicious Proxy traps are an unverified limitation, not a hostile-object guarantee.

export class CanonicalJsonError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "CanonicalJsonError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Optional observation budgets. Omitted fields keep the historical unbounded
 * persistence serializer behavior and must not change accepted canonical bytes.
 */
export type CanonicalSerializeLimits = {
  maxDepth?: number;
  maxNodes?: number;
  maxCollectionLength?: number;
  maxObjectProperties?: number;
  maxStringChars?: number;
  maxObjectKeyChars?: number;
};

type SerializeState = {
  seen: WeakSet<object>;
  limits: CanonicalSerializeLimits | undefined;
  nodes: number;
};

export function canonicalSerialize(value: unknown, limits?: CanonicalSerializeLimits): Buffer {
  return Buffer.from(
    serializeValue(value, { seen: new WeakSet<object>(), limits, nodes: 0 }, 1),
    "utf8",
  );
}

export function canonicalSerializeToUtf8(
  value: unknown,
  limits?: CanonicalSerializeLimits,
): string {
  return canonicalSerialize(value, limits).toString("utf8");
}

function exceedsCap(cap: number | undefined, actual: number): boolean {
  return cap !== undefined && actual > cap;
}

function serializeValue(value: unknown, state: SerializeState, depth: number): string {
  state.nodes += 1;
  if (exceedsCap(state.limits?.maxNodes, state.nodes)) {
    throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      if (exceedsCap(state.limits?.maxStringChars, value.length)) {
        throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
      }
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

  if (exceedsCap(state.limits?.maxDepth, depth)) {
    throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
  }
  if (state.seen.has(value)) {
    throw new CanonicalJsonError("CYCLIC_OBJECT");
  }
  state.seen.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, state, depth)
      : serializeObject(value, state, depth);
  } finally {
    state.seen.delete(value);
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

function isAccessorDescriptor(descriptor: PropertyDescriptor): boolean {
  return Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set");
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }
  if (isAccessorDescriptor(descriptor) || !Object.hasOwn(descriptor, "value")) {
    throw new CanonicalJsonError("ACCESSOR_PROPERTY");
  }
  return descriptor.value;
}

function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return index < length && String(index) === key;
}

function serializeArray(value: unknown[], state: SerializeState, depth: number): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor | undefined
  >;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }
  if (isAccessorDescriptor(lengthDescriptor) || !Object.hasOwn(lengthDescriptor, "value")) {
    throw new CanonicalJsonError("ACCESSOR_PROPERTY");
  }
  if (
    lengthDescriptor.writable !== true ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false
  ) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    Object.is(length, -0) ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new CanonicalJsonError("NON_PLAIN_OBJECT");
  }

  if (exceedsCap(state.limits?.maxCollectionLength, length)) {
    throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
  }

  const ownKeys = Reflect.ownKeys(descriptors);
  const indexValues = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      throw new CanonicalJsonError("SYMBOL_VALUE");
    }
    if (key === "length") {
      continue;
    }
    if (!isCanonicalArrayIndexKey(key, length)) {
      throw new CanonicalJsonError("EXTRA_ARRAY_PROPERTY");
    }
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
    const element = descriptorValue(descriptor);
    if (descriptor?.enumerable !== true) {
      throw new CanonicalJsonError("NON_ENUMERABLE_PROPERTY");
    }
    indexValues.set(key, element);
  }
  if (indexValues.size !== length) {
    throw new CanonicalJsonError("SPARSE_ARRAY");
  }

  const parts: string[] = [];
  for (let index = 0; index < length; index += 1) {
    parts.push(serializeValue(indexValues.get(String(index)), state, depth + 1));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(value: object, state: SerializeState, depth: number): string {
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

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  const collected: Array<[string, unknown]> = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      throw new CanonicalJsonError("SYMBOL_VALUE");
    }
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined;
    const propertyValue = descriptorValue(descriptor);
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      throw new CanonicalJsonError("DANGEROUS_OBJECT_KEY");
    }
    if (descriptor?.enumerable !== true) {
      throw new CanonicalJsonError("NON_ENUMERABLE_PROPERTY");
    }
    if (exceedsCap(state.limits?.maxObjectKeyChars, key.length)) {
      throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
    }
    collected.push([key, propertyValue]);
    if (exceedsCap(state.limits?.maxObjectProperties, collected.length)) {
      throw new CanonicalJsonError("RESOURCE_LIMIT_EXCEEDED");
    }
  }
  collected.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  const parts: string[] = [];
  for (const [key, propertyValue] of collected) {
    parts.push(`${JSON.stringify(key)}:${serializeValue(propertyValue, state, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}
