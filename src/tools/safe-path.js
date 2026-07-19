import path from 'path';

/**
 * Directories that are off-limits even though they sit inside the repo root.
 *
 * Being inside the root turns out to be necessary but not sufficient.
 * `.git/config` stores the remote URL, and a checkout cloned before the
 * credential handling in ./git.js was fixed has a GitHub token baked into it —
 * reachable by read_file, and from there printable into a Discord channel by
 * anyone who can mention the bot.
 *
 * This is defence in depth, not the fix: git.js no longer writes the token into
 * origin and scrubs existing checkouts on startup. This makes sure a checkout
 * that somehow still holds one can't be read regardless. It also keeps the bot
 * out of git internals generally, which it has no business editing by hand — it
 * has proper git tools for that.
 */
const BLOCKED_DIRS = new Set(['.git']);

/**
 * Resolve a caller-supplied path, guaranteeing it stays inside the repo root
 * and outside any blocked directory within it.
 *
 * The naive containment check — `resolved.startsWith(root)` — is subtly wrong:
 * with a root of "/srv/repo" it also accepts "/srv/repo-secrets/.env", because
 * the sibling directory shares the prefix as a *string* even though it is
 * outside the tree. Comparing against `root + path.sep` fixes that, with the
 * root itself allowed as an explicit special case.
 *
 * @param {string} filePath - Untrusted path, relative to the repo root
 * @param {string} root - The project's repo root. Required: with several projects
 *   in one process there is no single correct default, and guessing one could
 *   resolve a path against the wrong project's checkout.
 * @returns {string} Absolute path, guaranteed within the root
 * @throws {Error} If the path escapes the root or enters a blocked directory
 */
export function safeResolve(filePath, root) {
  if (!root) throw new Error('safeResolve requires an explicit repo root.');
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, filePath);

  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new Error(`Path "${filePath}" is outside the project repo. Staying in bounds.`);
  }

  // Checked on the resolved path rather than the caller's string, so "a/../.git"
  // and an absolute path into .git are caught alongside the plain form. Compared
  // case-insensitively because macOS and Windows would otherwise let ".GIT"
  // through to the same directory.
  const relative = path.relative(absRoot, resolved);
  if (relative) {
    const segments = relative.split(path.sep);
    const blocked = segments.find((segment) => BLOCKED_DIRS.has(segment.toLowerCase()));
    if (blocked) {
      throw new Error(
        `Path "${filePath}" is inside "${blocked}", which is off-limits. ` +
          'Use the git tools instead of reading or editing git internals.',
      );
    }
  }

  return resolved;
}
