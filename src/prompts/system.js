import fs from 'fs/promises';
import path from 'path';

const PROMPT_PATH = path.resolve(process.env.SYSTEM_PROMPT_PATH || './system-prompt.md');

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

let _cached = null;

export async function getSystemPrompt() {
  if (_cached) return _cached;

  try {
    _cached = await fs.readFile(PROMPT_PATH, 'utf-8');
    console.log(`[prompt] Loaded system prompt from ${PROMPT_PATH}`);
  } catch {
    console.warn(`[prompt] No system-prompt.md found at ${PROMPT_PATH} — using generic default.`);
    console.warn('[prompt] Copy system-prompt.example.md to system-prompt.md to customise.');
    _cached = GENERIC_DEFAULT;
  }

  return _cached;
}
