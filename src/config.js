import fs from 'fs';
import path from 'path';

/**
 * Project configuration, resolved per Discord guild.
 *
 * The bot can serve several unrelated projects from one process. Each guild maps
 * to a project with its own system prompt, repo, Drive folder, and tool packs —
 * so a game-dev server never sees another project's prompt or gains push access
 * to its repo.
 *
 * Two modes:
 *
 *   Single-project (no projects.json) — every setting comes from environment
 *   variables and the bot responds in every guild it's in. This is the original
 *   behaviour, kept intact so existing deployments upgrade without changes.
 *
 *   Multi-project (projects.json present) — each entry binds a guild ID to a
 *   project. Guilds with no entry get NO response. That strictness is the point:
 *   silently falling back to a default would hand any server the bot happens to
 *   join the default project's prompt and repo credentials.
 */

const CONFIG_PATH = path.resolve(process.env.PROJECTS_CONFIG_PATH || './projects.json');
const REPO_ROOT = process.env.REPO_ROOT || './repos';

function envProject() {
  return {
    id: 'default',
    name: process.env.PROJECT_NAME || 'default',
    guildId: null,
    systemPromptPath: path.resolve(process.env.SYSTEM_PROMPT_PATH || './system-prompt.md'),
    repoUrl: process.env.GITHUB_REPO_URL || null,
    repoPath: path.resolve(process.env.REPO_PATH || './repo'),
    githubToken: process.env.GITHUB_TOKEN || null,
    gitAuthorName: process.env.GIT_AUTHOR_NAME || 'Claude Bot',
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || null,
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
    toolPacks: parsePacks(process.env.ENABLED_TOOL_PACKS),
    todoDocId: process.env.TODO_DOC_ID || null,
    todoDocName: process.env.TODO_DOC_NAME || 'todo',
    allowedChannelIds: parseList(process.env.ALLOWED_CHANNEL_IDS),
  };
}

function parseList(raw) {
  if (!raw || !raw.trim()) return null;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

function parsePacks(raw) {
  return Array.isArray(raw) ? raw : parseList(raw);
}

/**
 * Merge one projects.json entry over the environment defaults.
 *
 * Env values act as the base so shared settings (git identity, GitHub token)
 * can stay in one place while each project overrides only what differs.
 */
function resolveEntry(key, entry, base) {
  const repoPath = entry.repoPath
    ? path.resolve(entry.repoPath)
    // Derive a distinct clone directory per project rather than inheriting the
    // env REPO_PATH — two projects sharing one checkout would have them
    // committing into each other's working tree.
    : path.resolve(REPO_ROOT, key);

  return {
    id: key,
    name: entry.name || key,
    guildId: String(entry.guildId),
    systemPromptPath: entry.systemPromptPath
      ? path.resolve(entry.systemPromptPath)
      : base.systemPromptPath,
    repoUrl: entry.repoUrl ?? base.repoUrl,
    repoPath,
    githubToken: entry.githubToken ?? base.githubToken,
    gitAuthorName: entry.gitAuthorName ?? base.gitAuthorName,
    gitAuthorEmail: entry.gitAuthorEmail ?? base.gitAuthorEmail,
    driveFolderId: entry.driveFolderId ?? base.driveFolderId,
    toolPacks: parsePacks(entry.toolPacks) ?? base.toolPacks,
    todoDocId: entry.todoDocId ?? base.todoDocId,
    todoDocName: entry.todoDocName ?? base.todoDocName,
    allowedChannelIds: parsePacks(entry.allowedChannelIds) ?? base.allowedChannelIds,
  };
}

function load() {
  const base = envProject();

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    console.log('[config] No projects.json — single-project mode from environment variables.');
    return { multi: false, projects: [base], byGuild: new Map() };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Refuse to start rather than silently reverting to single-project mode:
    // a typo in the config would otherwise expose every guild to the env
    // project's prompt and repo.
    throw new Error(`[config] ${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }

  const entries = Object.entries(parsed.projects || {});
  if (!entries.length) {
    throw new Error(`[config] ${CONFIG_PATH} has no "projects" entries.`);
  }

  const projects = [];
  const byGuild = new Map();

  for (const [key, entry] of entries) {
    if (!entry.guildId) {
      throw new Error(`[config] Project "${key}" is missing a guildId.`);
    }
    const resolved = resolveEntry(key, entry, base);
    if (byGuild.has(resolved.guildId)) {
      throw new Error(
        `[config] Guild ${resolved.guildId} is claimed by both ` +
          `"${byGuild.get(resolved.guildId).id}" and "${key}".`,
      );
    }
    byGuild.set(resolved.guildId, resolved);
    projects.push(resolved);
  }

  console.log(
    `[config] Multi-project mode: ${projects.length} project(s) — ` +
      projects.map((p) => `${p.name} (guild ${p.guildId})`).join(', '),
  );
  return { multi: true, projects, byGuild };
}

const state = load();

/** Every configured project — used at startup to prepare each repo. */
export function allProjects() {
  return state.projects;
}

export function isMultiProject() {
  return state.multi;
}

/**
 * Resolve the project for a guild.
 *
 * @param {string|null} guildId - Discord guild ID (null for DMs)
 * @returns {object|null} The project, or null if this guild isn't configured
 */
export function getProjectForGuild(guildId) {
  if (!state.multi) return state.projects[0];
  if (!guildId) return null;
  return state.byGuild.get(String(guildId)) || null;
}
