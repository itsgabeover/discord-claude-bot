import path from 'path';

const REPO_PATH = process.env.REPO_PATH || '.';

/**
 * Resolve a caller-supplied path, guaranteeing it stays inside the repo root.
 *
 * The naive version of this check — `resolved.startsWith(root)` — is subtly
 * wrong: with a root of "/srv/repo" it also accepts "/srv/repo-secrets/.env",
 * because the sibling directory shares the prefix as a *string* even though it
 * is outside the tree. Comparing against `root + path.sep` fixes that, with the
 * root itself allowed as an explicit special case.
 *
 * @param {string} filePath - Untrusted path, relative to the repo root
 * @param {string} [root] - Override the root (defaults to REPO_PATH)
 * @returns {string} Absolute path, guaranteed within the root
 * @throws {Error} If the path escapes the root
 */
export function safeResolve(filePath, root = REPO_PATH) {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, filePath);

  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new Error(`Path "${filePath}" is outside the project repo. Staying in bounds.`);
  }

  return resolved;
}
