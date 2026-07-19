import fs from 'fs/promises';
import path from 'path';


const GENERIC_DEFAULT = `You are a collaborative assistant living in a Discord server, helping a team build their project together.

You have access to tools that let you do real work:
- Read and write files in the project repo
- Commit and push to GitHub (which triggers a Vercel redeploy)
- Read and write Google Drive documents
- Send messages to Discord channels
- Process and resize images
- Search the web
- Run npm commands in the repo

When asked to build something, actually do it — read existing files first, make the changes, run a build check, then commit and push. Don't just describe what you'd do.

Keep responses concise and Discord-friendly. Use code blocks for code. When you write code, briefly explain what you did in plain language too.

To give this bot a personality and project-specific knowledge, copy system-prompt.example.md to system-prompt.md and fill it in.`;

// Cached per path, not globally: with several projects in one process a single
// cache would serve whichever prompt happened to load first to every project —
// exactly the leak this whole arrangement exists to prevent.
const _cache = new Map();

/**
 * Load a project's system prompt.
 *
 * @param {object} project - Resolved project config (see src/config.js)
 */
export async function getSystemPrompt(project) {
  const promptPath = path.resolve(project.systemPromptPath);
  if (_cache.has(promptPath)) return _cache.get(promptPath);

  let prompt;
  try {
    prompt = await fs.readFile(promptPath, 'utf-8');
    console.log(`[prompt:${project.id}] Loaded system prompt from ${promptPath}`);
  } catch {
    console.warn(`[prompt:${project.id}] No prompt file at ${promptPath} — using generic default.`);
    console.warn('[prompt] Copy system-prompt.example.md and point the project at it.');
    prompt = GENERIC_DEFAULT;
  }

  _cache.set(promptPath, prompt);
  return prompt;
}
