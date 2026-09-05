import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCandidateEvidence } from "../evidence/current-candidate-verify.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "multi-candidate-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('{"value":1}\n');
  const entry = {
    file: "payload.json",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const manifest = (entries = [entry]) => {
    writeFileSync(path.join(root, "files.json"), JSON.stringify(entries));
  };
  writeFileSync(path.join(root, entry.file), bytes);
  manifest();
  return { root, entry, manifest };
}

function rejects(root, code) {
  const result = verifyCandidateEvidence(root);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.code === code),
    JSON.stringify(result.errors),
  );
}

test("exact current payload bytes verify", (t) => {
  const { root, entry } = fixture(t);
  assert.deepEqual(verifyCandidateEvidence(root), { ok: true, files: [entry], errors: [] });
});

test("whitespace-only JSON change fails", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "payload.json"), '{"value": 1}\n');
  rejects(root, "SHA256_MISMATCH");
});

test("newline change fails", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "payload.json"), '{"value":1}\r\n');
  rejects(root, "SHA256_MISMATCH");
});

test("wrong byte count fails even with matching digest", (t) => {
  const { root, entry, manifest } = fixture(t);
  manifest([{ ...entry, bytes: entry.bytes + 1 }]);
  rejects(root, "BYTE_COUNT_MISMATCH");
});

test("missing file fails", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "payload.json"));
  rejects(root, "MISSING_FILE");
});

test("duplicate manifest path fails", (t) => {
  const { root, entry, manifest } = fixture(t);
  manifest([entry, entry]);
  rejects(root, "DUPLICATE_PATH");
});

for (const file of [
  "../payload.json",
  "sub/../payload.json",
  "./payload.json",
  "sub//payload.json",
]) {
  test(`noncanonical path ${file} fails`, (t) => {
    const { root, entry, manifest } = fixture(t);
    manifest([{ ...entry, file }]);
    rejects(root, "TRAVERSAL_OR_NONCANONICAL_PATH");
  });
}

for (const file of [
  "/tmp/payload.json",
  "C:\\payload.json",
  "C:payload.json",
  "\\\\host\\payload.json",
]) {
  test(`absolute path ${JSON.stringify(file)} fails`, (t) => {
    const { root, entry, manifest } = fixture(t);
    manifest([{ ...entry, file }]);
    rejects(root, "ABSOLUTE_OR_NONCANONICAL_PATH");
  });
}

test("NUL-containing path fails without echoing untrusted path", (t) => {
  const { root, entry, manifest } = fixture(t);
  manifest([{ ...entry, file: "sensitive\0path" }]);
  rejects(root, "INVALID_PATH");
  assert.ok(!JSON.stringify(verifyCandidateEvidence(root)).includes("sensitive"));
});

test("symlink payload fails even when target is inside evidence directory", (t) => {
  const { root, entry, manifest } = fixture(t);
  symlinkSync("payload.json", path.join(root, "link.json"));
  manifest([{ ...entry, file: "link.json" }]);
  rejects(root, "SYMLINK");
});

test("symlink parent directory fails", (t) => {
  const { root, entry, manifest } = fixture(t);
  symlinkSync(root, path.join(root, "link"), "dir");
  manifest([{ ...entry, file: "link/payload.json" }]);
  rejects(root, "SYMLINK");
});

test("non-regular payload fails", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "payload.json"));
  mkdirSync(path.join(root, "payload.json"));
  rejects(root, "NOT_REGULAR_FILE");
});

test("malformed JSON reports no parser excerpt", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "files.json"), "private-payload");
  rejects(root, "INVALID_MANIFEST_JSON");
  assert.ok(!JSON.stringify(verifyCandidateEvidence(root)).includes("private-payload"));
});

test("manifest symlink fails", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "files.json"));
  symlinkSync("payload.json", path.join(root, "files.json"));
  rejects(root, "SYMLINK");
});

test("all payload failures are diagnosed", (t) => {
  const { root, entry, manifest } = fixture(t);
  manifest([
    { ...entry, file: "missing-one" },
    { ...entry, file: "missing-two" },
  ]);
  assert.equal(verifyCandidateEvidence(root).errors.length, 2);
});

test("same-length byte change fails SHA-256", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "payload.json"), '{"value":2}\n');
  rejects(root, "SHA256_MISMATCH");
  assert.equal(verifyCandidateEvidence(root).errors.length, 1);
});

test("nested regular payload inside evidence directory verifies", (t) => {
  const { root, entry, manifest } = fixture(t);
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "nested/payload.json"), '{"value":1}\n');
  manifest([{ ...entry, file: "nested/payload.json" }]);
  assert.equal(verifyCandidateEvidence(root).ok, true);
});

test("symlink evidence directory fails", (t) => {
  const { root } = fixture(t);
  const link = `${root}-link`;
  symlinkSync(root, link, "dir");
  t.after(() => rmSync(link));
  rejects(link, "SYMLINK");
});

test("empty manifest and invalid entry fail closed", (t) => {
  const { root, manifest } = fixture(t);
  manifest([]);
  rejects(root, "INVALID_MANIFEST");
  manifest([null]);
  rejects(root, "INVALID_ENTRY");
});
