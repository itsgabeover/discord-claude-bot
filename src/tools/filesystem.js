import fs from 'fs/promises';
import path from 'path';

const REPO_PATH = process.env.REPO_PATH || '.';

// Resolve a relative path safely within the repo root.
// Prevents path traversal attacks (e.g. ../../etc/passwd).
function safeResolve(filePath) {
  const resolved = path.resolve(REPO_PATH, filePath);
  if (!resolved.startsWith(path.resolve(REPO_PATH))) {
    throw new Error(`Path "${filePath}" is outside the project repo. Staying in bounds.`);
  }
  return resolved;
}

export async function readFile(filePath) {
  try {
    const abs = safeResolve(filePath);
    const content = await fs.readFile(abs, 'utf-8');
    return `Contents of ${filePath}:\n\n${content}`;
  } catch (err) {
    return `Error reading ${filePath}: ${err.message}`;
  }
}

export async function writeFile(filePath, content) {
  try {
    const abs = safeResolve(filePath);
    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return `Successfully wrote ${filePath}`;
  } catch (err) {
    return `Error writing ${filePath}: ${err.message}`;
  }
}

export async function listDirectory(dirPath = '.') {
  try {
    const abs = safeResolve(dirPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });

    // Filter out noisy directories
    const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
    const filtered = entries.filter(e => !ignored.has(e.name));

    const lines = filtered.map(e => {
      const prefix = e.isDirectory() ? '📁' : '📄';
      return `${prefix} ${e.name}`;
    });

    return `Contents of ${dirPath || 'repo root'}:\n\n${lines.join('\n')}`;
  } catch (err) {
    return `Error listing ${dirPath}: ${err.message}`;
  }
}
