import fs from 'fs';
import { query, InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk';
import { getMcpServer, SERVER_NAME } from './tools/mcp.js';
import { getSystemPrompt } from './prompts/system.js';
import { downloadBuffer } from './tools/image.js';

/**
 * The Agent SDK implementation of chat(), an alternative to ./claude.js.
 *
 * Exposes exactly the same signature so ../handlers/message.js can pick one at
 * runtime without knowing which it got. Set USE_AGENT_SDK=1 to route here; the
 * Messages API path stays the default, and stays the rollback.
 *
 * What the SDK takes over: the agentic loop, prompt caching (automatic — the
 * hand-placed cache_control breakpoints in ./claude.js have no equivalent and
 * aren't needed), turn limits, and cost accounting.
 *
 * What it does NOT take over: the tools. Those are still the bot's own
 * functions, handed to the SDK as an in-process MCP server (see ./tools/mcp.js).
 */

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// The SDK has no per-turn tool-call cap — only maxTurns (assistant round trips)
// and maxBudgetUsd. MAX_TOOL_CALLS is reused as maxTurns because it is the
// closest available knob, but they are NOT the same unit: one turn can contain
// several parallel tool calls, so this is a looser bound than the Messages API
// path enforces. MAX_BUDGET_USD is the tighter, more meaningful cap here.
const MAX_TURNS = parseInt(process.env.MAX_TOOL_CALLS || '30', 10);

/**
 * Hard cost ceiling for a single reply, in USD.
 *
 * $1.00 is chosen to sit just above what a legitimately long turn costs, so it
 * bounds runaways without cutting real work short. On the default model
 * (claude-sonnet-4-6, $3/M in and $15/M out, cache reads ~0.1x):
 *
 *   - A full 30-tool-call turn — the MAX_TOOL_CALLS ceiling — costs roughly
 *     $0.72 warm, since the resent prefix is mostly cache reads and the output
 *     is what actually costs. A $0.50 cap would kill those turns partway.
 *   - The Messages API path's MAX_TOKENS_PER_TURN=150000 works out to about
 *     $0.37 on a cache-heavy turn and $1.05 cold and output-heavy, so $1.00 is
 *     close to the same bound expressed in the unit the SDK actually enforces.
 *
 * Worth revisiting if CLAUDE_MODEL changes: the same 30-call turn is about
 * $1.20 on claude-opus-4-8 ($5/$25), so this cap would bind earlier there.
 *
 * Set MAX_BUDGET_USD=0 to disable the cap entirely.
 */
const DEFAULT_BUDGET_USD = 1.0;
const MAX_BUDGET_USD = (() => {
  const raw = process.env.MAX_BUDGET_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_USD;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[agent] MAX_BUDGET_USD="${raw}" is not a number — using $${DEFAULT_BUDGET_USD}.`);
    return DEFAULT_BUDGET_USD;
  }
  // 0 (or negative) means no cap — the SDK option is simply omitted below.
  return parsed > 0 ? parsed : undefined;
})();

// Per-channel session IDs, so a channel's conversation continues across
// messages: Map<channelId, sessionId>
const sessions = new Map();

// How many channels' transcripts stay resident. Each is a full conversation
// including tool results (file contents, Drive docs), so this is the dominant
// term in the bot's steady-state heap.
const MAX_STORED_SESSIONS = parseInt(process.env.MAX_STORED_SESSIONS || '25', 10);

/**
 * Tokens a channel's session may reach before its history is dropped.
 *
 * `resume` replays the whole transcript into every subsequent turn, so each
 * file read stays in the prefix for the rest of the conversation. Production
 * showed one channel climbing 188k → 199k → 263k → 287k across four messages,
 * the last of which was a short follow-up question that cost $0.15 purely to
 * carry everything before it.
 *
 * Bounded by tokens rather than by turns, which is where this departs from
 * ../voice/session.js. Voice utterances all cost about the same, so counting
 * them is a fair proxy for size; text turns in that same log ran 59k to 432k,
 * so a turn count would fire after twenty trivial questions and not at all
 * during one long refactor. Tokens measure the thing actually being capped.
 *
 * Prompt caching is why this went unnoticed: most of a resumed prefix bills at
 * cache-read rates, so 432k tokens cost $0.36 rather than the $1.30 they would
 * fresh. Caching makes the growth cheaper, not absent — and it does far less
 * for latency, which tracks prefix size regardless of what the tokens cost.
 */
const DEFAULT_SESSION_TOKENS = 150000;

const MAX_SESSION_TOKENS = (() => {
  const raw = process.env.MAX_SESSION_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_SESSION_TOKENS;
  const parsed = parseInt(raw, 10);
  // NaN would compare false against the cap and silently disable it, so a typo
  // would read as "the cap is off" with nothing said. Same guard, and the same
  // reasoning, as MAX_BUDGET_USD above.
  if (Number.isNaN(parsed)) {
    console.warn(
      `[agent] MAX_SESSION_TOKENS="${raw}" is not a number — using ${DEFAULT_SESSION_TOKENS}.`,
    );
    return DEFAULT_SESSION_TOKENS;
  }
  // 0 (or negative) means no cap — sessions grow unbounded.
  return parsed > 0 ? parsed : 0;
})();

/**
 * InMemorySessionStore with an LRU bound.
 *
 * The bare store never evicts: every channel the bot has ever answered in keeps
 * its full transcript for the life of the process, so memory only ever grows.
 * `sessions.delete(channelId)` in clearHistory() drops the channel→sessionId
 * mapping but leaves the transcript itself resident, which made !clear look
 * like it freed memory when it freed nothing.
 *
 * This wraps rather than subclasses because eviction needs the SessionKey, and
 * a key's `projectKey` is derived by the SDK from the resolved `cwd` — it is
 * not settable through query options, so we cannot reconstruct a key we did not
 * observe. Recording keys as they pass through append()/load() sidesteps the
 * derivation entirely: we only ever delete keys the SDK itself handed us.
 */
export class BoundedSessionStore {
  #inner;
  #max;
  // sessionId -> Map<keyString, SessionKey>. Insertion order is the LRU order;
  // re-inserting on touch moves a session to the newest end.
  #tracked = new Map();

  constructor(inner, max) {
    this.#inner = inner;
    this.#max = max;
  }

  #touch(key) {
    const { sessionId } = key;
    const keyStr = `${key.projectKey}\u0000${sessionId}\u0000${key.subpath ?? ''}`;
    const existing = this.#tracked.get(sessionId);
    if (existing) {
      existing.set(keyStr, key);
      this.#tracked.delete(sessionId); // re-insert at the newest end
      this.#tracked.set(sessionId, existing);
    } else {
      this.#tracked.set(sessionId, new Map([[keyStr, key]]));
    }
  }

  async #evictOverflow() {
    while (this.#tracked.size > this.#max) {
      // Map iteration order is insertion order, so the first entry is the
      // least-recently-touched session.
      const [oldest] = this.#tracked.keys();
      await this.evictSession(oldest);
    }
  }

  /** Drop one session's transcript, including any subagent subpaths. */
  async evictSession(sessionId) {
    const keys = this.#tracked.get(sessionId);
    if (!keys) return;
    this.#tracked.delete(sessionId);
    for (const key of keys.values()) {
      // A store that has already forgotten this key is the desired end state,
      // so a failed delete must not take down the turn that triggered it.
      try {
        await this.#inner.delete(key);
      } catch (err) {
        console.warn(`[agent] session evict failed for ${sessionId}: ${err.message}`);
      }
    }
  }

  async append(key, entries) {
    this.#touch(key);
    const result = await this.#inner.append(key, entries);
    await this.#evictOverflow();
    return result;
  }

  async load(key) {
    this.#touch(key);
    return this.#inner.load(key);
  }

  async delete(key) {
    this.#tracked.delete(key.sessionId);
    return this.#inner.delete(key);
  }

  listSessions(projectKey) {
    return this.#inner.listSessions(projectKey);
  }

  listSessionSummaries(projectKey) {
    return this.#inner.listSessionSummaries(projectKey);
  }

  listSubkeys(key) {
    return this.#inner.listSubkeys(key);
  }
}

// Sessions are kept in memory rather than on disk. The SDK's default is to
// write transcripts to ~/.claude/projects/*.jsonl, which on Render's ephemeral
// disk both survives nothing across a redeploy and writes for no reason. In
// memory matches what ./claude.js already does — history is lost on restart —
// so this is not a behaviour regression. Swap in a Redis/S3 SessionStore here
// if conversations should ever outlive the process.
const sessionStore = new BoundedSessionStore(
  new InMemorySessionStore(),
  MAX_STORED_SESSIONS,
);

/**
 * The SDK built-in tools the bot is allowed to use.
 *
 * Read-only on purpose. The bot already has write tools of its own — write_file,
 * the git pack, run_npm — and those pin every path inside the project repo via
 * safeResolve(). These three add what the bot genuinely lacks: real search.
 * list_directory can only list one directory at a time, so finding a symbol
 * across a repo currently means a chain of read_file calls.
 *
 * Bash is deliberately absent and should stay that way — anyone who can @mention
 * the bot can steer it, and Bash turns that into a shell on the host.
 */
const READONLY_BUILTINS = ['Read', 'Grep', 'Glob'];

/**
 * Where the built-in tools are rooted, and whether they're available at all.
 *
 * This scoping is the whole reason the built-ins are safe to enable. They are
 * bounded by `cwd`, which defaults to the bot's OWN process directory — one
 * level above the checkout, since repoPath defaults to ./repo, and the directory
 * that holds .env, google-credentials.json, and projects.json. Pointing cwd at
 * the repo is what makes their reach equivalent to the bot's own
 * safeResolve()-guarded tools rather than a way around them.
 *
 * If the checkout is missing — cloneRepoIfNeeded() failed at startup and the bot
 * kept serving other projects — the built-ins are dropped instead of falling
 * back to the default cwd. Falling back would silently root them at the bot's
 * own credentials, which is exactly what this scoping exists to prevent, so a
 * broken repo loses search rather than gaining reach.
 *
 * Not cached: it's one stat() per Discord message, and a repo that appears after
 * startup should start working without a restart.
 *
 * @param {object} project - Resolved project config
 * @returns {{cwd: string|undefined, builtinTools: string[]}}
 */
function workspaceFor(project) {
  let isRepo = false;
  try {
    isRepo = Boolean(project.repoPath) && fs.statSync(project.repoPath).isDirectory();
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    console.warn(
      `[agent:${project.id}] No repo at ${project.repoPath} — built-in tools ` +
        'disabled for this project (they would otherwise be rooted at the bot itself).',
    );
    return { cwd: undefined, builtinTools: [] };
  }

  return { cwd: project.repoPath, builtinTools: READONLY_BUILTINS };
}

function usageFooter(totalTokens, costUsd) {
  const cost = typeof costUsd === 'number' ? ` · $${costUsd.toFixed(4)}` : '';
  return `\n\n-# ~${totalTokens.toLocaleString()} tokens this turn${cost}`;
}

/**
 * Total tokens for a turn, counting cached input.
 *
 * Same reasoning as ./claude.js: input_tokens counts only the uncached
 * remainder, so summing input + output alone would make the number shrink as
 * the cache hit rate rises rather than reflecting the work actually done.
 */
function totalTokensFrom(usage = {}) {
  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_creation_input_tokens: cacheWrite = 0,
    cache_read_input_tokens: cacheRead = 0,
  } = usage;
  return input_tokens + output_tokens + cacheWrite + cacheRead;
}

export function clearHistory(channelId) {
  const sessionId = sessions.get(channelId);
  sessions.delete(channelId);
  // Dropping the mapping alone leaves the transcript resident, so !clear used
  // to free nothing. Deliberately not awaited: this stays synchronous to match
  // ./claude.js's clearHistory, and the user-facing confirmation should not
  // wait on a store cleanup that cannot fail in a way they could act on.
  if (sessionId) {
    sessionStore.evictSession(sessionId).catch((err) => {
      console.warn(`[agent] clearHistory evict failed: ${err.message}`);
    });
  }
  return 'Conversation history cleared for this channel.';
}

/**
 * Session-based history has no message count to report — the transcript lives
 * inside the SDK session rather than in an array here. Reported as 0 or 1 so
 * the !history command keeps working rather than crashing.
 */
export function getHistoryLength(channelId) {
  return sessions.has(channelId) ? 1 : 0;
}

/**
 * Build the one user message this turn sends.
 *
 * Images have to be downloaded and base64-encoded first: unlike the Messages
 * API, the SDK will not accept an image by URL, so passing the Discord CDN link
 * through — which is what ./claude.js does — silently gets no image at all.
 */
async function buildUserContent(text, images, username) {
  const content = [];

  for (const img of images) {
    try {
      const buffer = await downloadBuffer(img.url);
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.contentType || 'image/png',
          data: buffer.toString('base64'),
        },
      });
      // See ./claude.js: the image block is what Claude can look at, but
      // process_image needs the address, and nothing else in the turn carries
      // it. Without this line an attached image can be described but not saved.
      content.push({
        type: 'text',
        text: `[Attachment URL: ${img.url} — pass this to process_image to save it into the repo.]`,
      });
    } catch (err) {
      // One unreadable attachment shouldn't sink the whole message — tell
      // Claude what happened and let it respond to the text.
      console.error('[agent] Could not attach image:', err.message);
      content.push({
        type: 'text',
        text: `[An image was attached but could not be downloaded: ${err.message}]`,
      });
    }
  }

  content.push({ type: 'text', text: `**${username}:** ${text}` });
  return content;
}

/**
 * Ask Claude to summarize an unfinished turn, with no tools available.
 *
 * Ported from ./claude.js: when a cap is hit, a canned "try again" is much less
 * useful than having Claude describe what it got done and hand the user
 * ready-to-send follow-ups. The SDK's own cap handling just ends the run with
 * an error subtype and no text, so this has to be re-issued explicitly.
 */
async function summarizeIncompleteTask(project, sessionId, reason) {
  try {
    let summary = '';
    for await (const message of query({
      prompt:
        `[SYSTEM NOTE: You've hit this turn's ${reason} and cannot call any more ` +
        `tools right now. Do not attempt to call any tools. Briefly summarize what ` +
        `you completed, what's left, and give the user 2-3 short, ready-to-send ` +
        `follow-up messages that would let you finish the rest across separate turns.]`,
      options: {
        model: MODEL,
        resume: sessionId,
        sessionStore,
        tools: [], // no built-ins, and no MCP servers — it can only answer in text
        systemPrompt: await getSystemPrompt(project),
        maxTurns: 1,
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        summary = message.result;
      }
    }
    return summary || `I hit this turn's ${reason} — try breaking your request into smaller steps.`;
  } catch (err) {
    console.error('[agent] Failed to summarize incomplete task:', err.message);
    return `I hit this turn's ${reason} — the task might be too complex for a single message. Try breaking it into smaller steps.`;
  }
}

/**
 * Send a message to Claude via the Agent SDK and get a response.
 *
 * Signature-compatible with ./claude.js chat().
 *
 * @param {object} project - Resolved project config
 * @param {string} channelId - Discord channel or thread ID (session key)
 * @param {string} text - The user's message text
 * @param {Array<{url: string, contentType: string}>} images - Image attachments
 * @param {string} username - Discord username for context
 * @param {(name: string, input: object) => void} [onToolCall] - Fired before
 *   each tool runs, to drive the live progress message
 * @returns {Promise<string>} Claude's final text response
 */
export async function chat(project, channelId, text, images = [], username = 'User', onToolCall) {
  const { server, toolNames } = getMcpServer(project);
  const { cwd, builtinTools } = workspaceFor(project);
  const allowed = [...toolNames, ...builtinTools];
  const content = await buildUserContent(text, images, username);
  const resumeId = sessions.get(channelId);

  // Streaming input mode. Required rather than optional: the plain-string form
  // of `prompt` cannot carry image blocks at all.
  async function* promptStream() {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  }

  let totalTokens = 0;
  let costUsd;
  let finalText = '';
  let capReason = null;
  let sessionId = resumeId;

  console.log(
    `[agent:${project.id}] channel=${channelId} ${resumeId ? 'resuming' : 'starting'} session` +
      ` (${toolNames.length} bot tools` +
      (builtinTools.length ? ` + ${builtinTools.join('/')} in ${cwd}` : ', no built-ins') +
      ')',
  );

  for await (const message of query({
    prompt: promptStream(),
    options: {
      model: MODEL,
      // A plain string fully REPLACES Claude Code's default system prompt. That
      // is the point: the preset would drop a coding-agent persona on top of
      // the bot's own, and there is no way to subtract parts of it afterwards.
      systemPrompt: await getSystemPrompt(project),
      mcpServers: { [SERVER_NAME]: server },
      // Read-only built-ins only, rooted at the project repo by `cwd` below.
      // Everything that writes stays with the bot's own tools, which pin paths
      // via safeResolve(). Write / Edit / Bash are never listed here — Bash in
      // particular would hand anyone who can @mention the bot a shell.
      tools: builtinTools,
      // Rooting the built-ins at the checkout instead of the bot's own
      // directory. Omitted when the repo is missing, in which case builtinTools
      // is empty too, so there is nothing for a default cwd to scope.
      ...(cwd ? { cwd } : {}),
      // Auto-approve exactly the bot's tools plus those built-ins. Anything
      // else falls through to canUseTool below, which denies — so a tool
      // arriving from somewhere unexpected fails closed instead of running.
      allowedTools: allowed,
      canUseTool: async (toolName, input) => {
        // updatedInput must echo the original input — it REPLACES what the tool
        // receives, so returning {} here would strip every argument.
        if (allowed.includes(toolName)) return { behavior: 'allow', updatedInput: input };
        console.warn(`[agent:${project.id}] denied unexpected tool: ${toolName}`);
        return { behavior: 'deny', message: `${toolName} is not available to this bot.` };
      },
      hooks: {
        // PreToolUse rather than canUseTool for progress reporting: canUseTool
        // never fires for tools that are already auto-approved via allowedTools,
        // so every one of the bot's own tools would be invisible to it.
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (onToolCall) {
                  // MCP-qualified name back to the bare tool name the progress
                  // labels in ../handlers/message.js are keyed on.
                  const bare = String(input.tool_name || '').replace(
                    `mcp__${SERVER_NAME}__`,
                    '',
                  );
                  try {
                    onToolCall(bare, input.tool_input);
                  } catch {
                    /* progress display is best-effort */
                  }
                }
                return {};
              },
            ],
          },
        ],
      },
      maxTurns: MAX_TURNS,
      ...(MAX_BUDGET_USD ? { maxBudgetUsd: MAX_BUDGET_USD } : {}),
      resume: resumeId,
      sessionStore,
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }

    if (message.type === 'result') {
      sessionId = message.session_id || sessionId;
      totalTokens = totalTokensFrom(message.usage);
      costUsd = message.total_cost_usd;

      if (message.subtype === 'success') {
        finalText = message.result;
      } else if (message.subtype === 'error_max_turns') {
        capReason = 'turn limit';
      } else if (message.subtype === 'error_max_budget_usd') {
        capReason = 'cost budget for this turn';
      } else {
        capReason = `run error (${message.subtype})`;
      }
    }
  }

  if (sessionId) sessions.set(channelId, sessionId);

  console.log(
    `[agent:${project.id}] channel=${channelId} done: ${totalTokens} tokens` +
      (typeof costUsd === 'number' ? `, $${costUsd.toFixed(4)}` : '') +
      (capReason ? ` (stopped: ${capReason})` : ''),
  );

  // Composed before the reset below, because summarizeIncompleteTask() resumes
  // this same sessionId — clearing first would evict the transcript it needs,
  // and the eviction is unawaited, so it would fail intermittently rather than
  // every time. That is the worst available failure: a turn that already hit a
  // cap losing its explanation of what it managed to finish.
  const body = capReason
    ? await summarizeIncompleteTask(project, sessionId, capReason)
    : finalText.trim() || '*(no text response)*';

  // Reset *after* answering, not before. Checking on the way in would drop the
  // context the current message probably depends on — a follow-up like "now do
  // the same for the other file" is exactly the kind of message that arrives on
  // a large session — and would leave the user watching the bot forget the
  // thread mid-task with no idea why. Trimming on the way out spends one more
  // expensive turn and starts the next one clean.
  //
  // Said out loud rather than only logged: silent context loss is
  // indistinguishable from the bot ignoring what was just agreed, and the next
  // message is the one that would hit it.
  let resetNote = '';
  if (MAX_SESSION_TOKENS > 0 && totalTokens > MAX_SESSION_TOKENS) {
    console.log(
      `[agent:${project.id}] channel=${channelId} session at ${totalTokens} tokens ` +
        `(cap ${MAX_SESSION_TOKENS}) — resetting history.`,
    );
    clearHistory(channelId);
    resetNote = '\n\n-# History reset — this thread got long enough to be slow. Next message starts fresh.';
  }

  return body + usageFooter(totalTokens, costUsd) + resetNote;
}
