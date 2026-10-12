import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultDirectory = fileURLToPath(
  new URL("../../docs/evidence/current-candidate/", import.meta.url),
);

function fail(code) {
  throw new Error(code);
}

function safePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("INVALID_PATH");
  }
  if (path.isAbsolute(value) || path.win32.parse(value).root !== "" || value.includes("\\")) {
    fail("ABSOLUTE_OR_NONCANONICAL_PATH");
  }
  if (value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    fail("TRAVERSAL_OR_NONCANONICAL_PATH");
  }
  return value;
}

function readRegularFile(root, relativePath) {
  let current = root;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail("SYMLINK");
    if (index < parts.length - 1 && !info.isDirectory()) fail("NOT_DIRECTORY");
    if (index === parts.length - 1 && !info.isFile()) fail("NOT_REGULAR_FILE");
  }
  const resolved = realpathSync(current);
  if (!resolved.startsWith(`${root}${path.sep}`)) fail("OUTSIDE_EVIDENCE_DIRECTORY");
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) fail("NOT_REGULAR_FILE");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errorCode(error) {
  // Do not expose payload bytes, JSON parser excerpts, or absolute filesystem paths.
  if (error?.code === "ENOENT") return "MISSING_FILE";
  if (error?.code === "ELOOP") return "SYMLINK";
  if (error instanceof SyntaxError) return "INVALID_MANIFEST_JSON";
  if (/^[A-Z_]+$/.test(error?.message ?? "")) return error.message;
  return "UNREADABLE_EVIDENCE";
}

export function verifyCandidateEvidence(directory = defaultDirectory) {
  const files = [];
  const errors = [];
  let root;
  let manifest;
  try {
    root = path.resolve(directory);
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) fail("SYMLINK");
    if (!lstatSync(root).isDirectory()) fail("NOT_DIRECTORY");
    manifest = JSON.parse(readRegularFile(root, "files.json").toString("utf8"));
    if (!Array.isArray(manifest) || manifest.length === 0) fail("INVALID_MANIFEST");
  } catch (error) {
    return { ok: false, files, errors: [{ file: "files.json", code: errorCode(error) }] };
  }

  const seen = new Set();
  for (const [index, entry] of manifest.entries()) {
    let file;
    try {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("INVALID_ENTRY");
      file = safePath(entry.file);
      if (seen.has(file)) fail("DUPLICATE_PATH");
      seen.add(file);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail("INVALID_BYTE_COUNT");
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        fail("INVALID_SHA256");
      }
      const bytes = readRegularFile(root, file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const codes = [];
      if (bytes.length !== entry.bytes) codes.push("BYTE_COUNT_MISMATCH");
      if (sha256 !== entry.sha256) codes.push("SHA256_MISMATCH");
      files.push({ file, bytes: bytes.length, sha256 });
      for (const code of codes) errors.push({ index, file, code });
    } catch (error) {
      errors.push({ index, ...(file === undefined ? {} : { file }), code: errorCode(error) });
    }
  }
  return { ok: errors.length === 0, files, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyCandidateEvidence();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
