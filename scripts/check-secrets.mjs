import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const allowedSecretLikeNames = new Set([".env.example"]);
const forbiddenFileNamePatterns = [
  { id: "env-file", pattern: /^\.env(?:\..+)?$/ },
  { id: "pem-file", pattern: /\.pem$/i },
  { id: "key-file", pattern: /\.key$/i },
  { id: "ssh-identity", pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)$/i },
];
const contentPatterns = [
  { id: "private-key-material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { id: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  {
    id: "api-secret-fixture",
    pattern: /(?:bearer|api[_-]?secret|api[_-]?key)\s*[:=]\s*['"][^'"]{16,}['"]/i,
  },
];

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

const findings = [];
const files = listTrackedFiles();

for (const relativePath of files) {
  const fileName = path.basename(relativePath);

  if (
    !allowedSecretLikeNames.has(fileName) &&
    forbiddenFileNamePatterns.some(({ pattern }) => pattern.test(fileName))
  ) {
    const rule = forbiddenFileNamePatterns.find(({ pattern }) => pattern.test(fileName));
    findings.push(`${relativePath}: ${rule?.id ?? "forbidden-filename"}`);
    continue;
  }

  const absolutePath = path.join(repositoryRoot, relativePath);
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  if (metadata.size > 1_000_000) {
    continue;
  }

  const content = await readFile(absolutePath, "utf8");
  if (content.includes("\0")) {
    continue;
  }

  for (const { id, pattern } of contentPatterns) {
    if (pattern.test(content)) {
      findings.push(`${relativePath}: ${id}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed (${files.length} tracked files inspected).\n`);
}
