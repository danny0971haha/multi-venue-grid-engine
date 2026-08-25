const JSON_ESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Detect duplicate object keys in already-validated JSON text.
 * JSON.parse last-key-wins is not an authoritative risk meaning.
 * Keys are compared after JSON unescaping; diagnostics must not receive them.
 */
export function jsonTextHasDuplicateKeys(text: string): boolean {
  try {
    const cursor = { index: 0 };
    skipValue(text, cursor);
    skipWhitespace(text, cursor);
    return false;
  } catch (error) {
    if (isDuplicateJsonKeyError(error)) {
      return true;
    }
    throw error;
  }
}

function skipWhitespace(text: string, cursor: { index: number }): void {
  while (cursor.index < text.length) {
    const char = text.charAt(cursor.index);
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      return;
    }
    cursor.index += 1;
  }
}

function skipValue(text: string, cursor: { index: number }): void {
  skipWhitespace(text, cursor);
  const char = text.charAt(cursor.index);
  if (char === '"') {
    readJsonString(text, cursor);
    return;
  }
  if (char === "{") {
    skipObject(text, cursor);
    return;
  }
  if (char === "[") {
    skipArray(text, cursor);
    return;
  }
  if (char === "t") {
    cursor.index += 4;
    return;
  }
  if (char === "f") {
    cursor.index += 5;
    return;
  }
  if (char === "n") {
    cursor.index += 4;
    return;
  }
  skipNumber(text, cursor);
}

function skipObject(text: string, cursor: { index: number }): void {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text.charAt(cursor.index) === "}") {
    cursor.index += 1;
    return;
  }
  const keys = new Set<string>();
  while (true) {
    skipWhitespace(text, cursor);
    const key = readJsonString(text, cursor);
    if (keys.has(key)) {
      throw duplicateKeySentinel;
    }
    keys.add(key);
    skipWhitespace(text, cursor);
    cursor.index += 1;
    skipValue(text, cursor);
    skipWhitespace(text, cursor);
    if (text.charAt(cursor.index) === ",") {
      cursor.index += 1;
      continue;
    }
    cursor.index += 1;
    return;
  }
}

function skipArray(text: string, cursor: { index: number }): void {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text.charAt(cursor.index) === "]") {
    cursor.index += 1;
    return;
  }
  while (true) {
    skipValue(text, cursor);
    skipWhitespace(text, cursor);
    if (text.charAt(cursor.index) === ",") {
      cursor.index += 1;
      continue;
    }
    cursor.index += 1;
    return;
  }
}

function skipNumber(text: string, cursor: { index: number }): void {
  const char = text.charAt(cursor.index);
  if (char === "-") {
    cursor.index += 1;
  }
  while (cursor.index < text.length) {
    const next = text.charAt(cursor.index);
    if (
      (next >= "0" && next <= "9") ||
      next === "." ||
      next === "e" ||
      next === "E" ||
      next === "+" ||
      next === "-"
    ) {
      cursor.index += 1;
      continue;
    }
    return;
  }
}

function readJsonString(text: string, cursor: { index: number }): string {
  cursor.index += 1;
  let value = "";
  while (cursor.index < text.length) {
    const char = text.charAt(cursor.index);
    if (char === '"') {
      cursor.index += 1;
      return value;
    }
    if (char === "\\") {
      const escaped = text.charAt(cursor.index + 1);
      if (escaped === "u") {
        const hex = text.slice(cursor.index + 2, cursor.index + 6);
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor.index += 6;
        continue;
      }
      value += JSON_ESCAPE[escaped] ?? escaped;
      cursor.index += 2;
      continue;
    }
    value += char;
    cursor.index += 1;
  }
  return value;
}

const duplicateKeySentinel = new Error("DUPLICATE_JSON_KEY");
duplicateKeySentinel.name = "DuplicateJsonKeyError";

function isDuplicateJsonKeyError(error: unknown): boolean {
  return error instanceof Error && error.name === "DuplicateJsonKeyError";
}
