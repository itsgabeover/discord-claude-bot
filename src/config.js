import fs from 'fs';
import path from 'path';

/**
 * Project configuration, resolved per Discord channel.
 *
 * The bot can serve several unrelated projects from one process. Each project
 * has its own system prompt, repo, Drive folder, and tool packs — so a game-dev
 * server never sees another project's prompt or gains push access to its repo.
 *
 * Two modes:
 *
 *   Single-project (no projects.json) — every setting comes from environment
 *   variables and the bot responds in every guild it's in. This is the original
 *   behaviour, kept intact so existing deployments upgrade without changes.
 *
 *   Multi-project (projects.json present) — each entry claims a guild, and
 *   optionally specific channels within it. Anything unclaimed gets NO response.
 *   That strictness is the point: silently falling back to a default would hand
 *   any server the bot happens to join the default project's prompt and repo
 *   credentials.
 *
 * Within a guild, projects split by channel. An entry with `channelIds` serves
 * only those channels; an entry without them is that guild's default and serves
 * everything else. That is what lets one server work on more than one repo —
 * #app-dev on the phone app, the rest of the server on the web app — while a
 * given message still resolves to exactly one project. Nothing downstream
 * changes: every filesystem and git tool still sees a single repo root, and no
 * conversation ever spans two checkouts.
 *
 * A guild may have at most one default, and no two projects may claim the same
 * channel. Both are startup errors rather than a silently arbitrary pick.
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
  // Normalised to strings because Discord IDs are 64-bit snowflakes: written
  // unquoted in JSON they parse as Numbers and lose precision, so "...857" can
  // come back as "...860" and silently match nothing.
  const channelIds = parsePacks(entry.channelIds)?.map(String) ?? null;

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
    channelIds,
    // A channel-scoped project is by definition allowed in the channels that
    // route to it, so its routing list doubles as its allowlist. Without this,
    // an env-level ALLOWED_CHANNEL_IDS set for some other purpose would block
    // the very channel that selected the project — a confusing failure, since
    // the routing table would look correct while the bot stayed silent.
    allowedChannelIds: parsePacks(entry.allowedChannelIds) ?? channelIds ?? base.allowedChannelIds,
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
  // Two routing tables, checked channel-first. A project with channelIds lands
  // in byChannel and claims nothing else; one without lands in byGuild as that
  // server's fallback.
  const byGuild = new Map();
  const byChannel = new Map();

  for (const [key, entry] of entries) {
    if (!entry.guildId) {
      throw new Error(`[config] Project "${key}" is missing a guildId.`);
    }
    const resolved = resolveEntry(key, entry, base);

    if (resolved.channelIds?.length) {
      for (const channelId of resolved.channelIds) {
        const owner = byChannel.get(channelId);
        if (owner) {
          throw new Error(
            `[config] Channel ${channelId} is claimed by both ` +
              `"${owner.id}" and "${key}". A channel routes to exactly one repo.`,
          );
        }
        byChannel.set(channelId, resolved);
      }
    } else {
      const owner = byGuild.get(resolved.guildId);
      if (owner) {
        throw new Error(
          `[config] Guild ${resolved.guildId} has two projects with no channelIds — ` +
            `"${owner.id}" and "${key}". Give one of them channelIds, or move it to ` +
            'its own server: with nothing to tell them apart there is no way to ' +
            'route a message, and guessing could push to the wrong repo.',
        );
      }
      byGuild.set(resolved.guildId, resolved);
    }

    projects.push(resolved);
  }

  console.log(
    `[config] Multi-project mode: ${projects.length} project(s) — ` +
      projects
        .map((p) => {
          const scope = p.channelIds?.length
            ? `guild ${p.guildId}, ${p.channelIds.length} channel(s)`
            : `guild ${p.guildId}, default`;
          return `${p.name} (${scope})`;
        })
        .join(', '),
  );
  return { multi: true, projects, byGuild, byChannel };
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
 * Resolve the project that serves a given channel.
 *
 * Channel-scoped projects win over the guild default, so a server can put one
 * repo behind specific channels and leave the rest to another. Falls through to
 * null when nothing claims the channel or the guild — the bot then stays silent
 * rather than serving some other project's repo and push credentials.
 *
 * @param {string|null} guildId - Discord guild ID (null for DMs)
 * @param {string|null} channelId - Discord channel or thread ID
 * @returns {object|null} The project, or null if nothing is configured for it
 */
export function getProjectForChannel(guildId, channelId) {
  if (!state.multi) return state.projects[0];

  if (channelId) {
    const scoped = state.byChannel.get(String(channelId));
    if (scoped) return scoped;
  }

  if (!guildId) return null;
  return state.byGuild.get(String(guildId)) || null;
}

/**
 * Resolve the project for a guild, ignoring channel routing.
 *
 * Kept for callers that only have a guild — it returns the guild's default and
 * will miss channel-scoped projects, so prefer getProjectForChannel() anywhere
 * a channel is available.
 *
 * @param {string|null} guildId - Discord guild ID (null for DMs)
 * @returns {object|null} The guild's default project, or null
 */
export function getProjectForGuild(guildId) {
  if (!state.multi) return state.projects[0];
  if (!guildId) return null;
  return state.byGuild.get(String(guildId)) || null;
}
