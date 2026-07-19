import path from 'path';

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
 * @param {string} root - The project's repo root. Required: with several projects
 *   in one process there is no single correct default, and guessing one could
 *   resolve a path against the wrong project's checkout.
 * @returns {string} Absolute path, guaranteed within the root
 * @throws {Error} If the path escapes the root
 */
export function safeResolve(filePath, root) {
  if (!root) throw new Error('safeResolve requires an explicit repo root.');
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, filePath);

  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new Error(`Path "${filePath}" is outside the project repo. Staying in bounds.`);
  }

  return resolved;
}
