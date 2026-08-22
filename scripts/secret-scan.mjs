import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const allowedSecretLikeNames = new Set([".env.example"]);
const forbiddenFileNamePatterns = [
  /^\.env(?:\..+)?$/,
  /\.pem$/i,
  /\.key$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];
const contentPatterns = [
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
];

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

const findings = [];
const files = await listFiles(repositoryRoot);

for (const absolutePath of files) {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  const fileName = path.basename(relativePath);

  if (
    !allowedSecretLikeNames.has(fileName) &&
    forbiddenFileNamePatterns.some((pattern) => pattern.test(fileName))
  ) {
    findings.push(`${relativePath}: forbidden secret-like filename`);
  }

  const metadata = await stat(absolutePath);
  if (metadata.size > 1_000_000) {
    continue;
  }

  const content = await readFile(absolutePath, "utf8");
  if (content.includes("\0")) {
    continue;
  }

  for (const { label, pattern } of contentPatterns) {
    if (pattern.test(content)) {
      findings.push(`${relativePath}: detected ${label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed (${files.length} repository files inspected).\n`);
}
