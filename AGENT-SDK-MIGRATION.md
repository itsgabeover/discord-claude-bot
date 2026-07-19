# Agent SDK migration

Context for anyone (human or agent) picking this repo up after the change.

## TL;DR

The bot can now run its conversation loop on the **Claude Agent SDK** instead of
its own hand-rolled loop over the Messages API. Both paths ship. The Messages API
path is still the default; the SDK path is behind `USE_AGENT_SDK=1`.

The 22 tools did **not** move. They are the same functions, in the same files,
running in the same process. Only the loop around them changed.

## Why

The hand-rolled loop in `src/claude.js` works, and nothing about it was broken.
What it doesn't have is the surrounding harness — subagents, hooks, skills,
compaction, plan mode, structured cost accounting. Those come free with the SDK,
and reimplementing them one at a time is the road this repo was already walking:
`summarizeIncompleteTask()`, `withCacheBreakpoint()`, and the tool-call caps are
each a hand-built slice of what the harness does natively.

The migration was done behind a flag rather than as a replacement because the
bot is deployed and could not be exercised end-to-end during the work — there
were no Discord or Anthropic credentials in the environment where it was
written. See **Verification status** below for exactly what was and wasn't
proven.

## Architecture

### Before

```
Discord message
  └─ handlers/message.js
       └─ claude.js chat()
            ├─ hand-rolled agentic loop
            ├─ manual cache_control breakpoints
            ├─ MAX_TOOL_CALLS / MAX_TOKENS_PER_TURN caps
            └─ tools/index.js executeTool(name, input, project)
                 └─ the 22 tool functions
```

### After (`USE_AGENT_SDK=1`)

```
Discord message
  └─ handlers/message.js          ← picks a backend, otherwise unchanged
       └─ agent.js chat()          ← same signature as claude.js chat()
            └─ Agent SDK query()
                 ├─ spawns a bundled `claude` CLI subprocess (owns the loop)
                 ├─ automatic prompt caching
                 ├─ maxTurns / maxBudgetUsd
                 └─ tools/mcp.js   ← in-process MCP server
                      └─ the same 22 tool functions, in THIS process
```

The subprocess detail matters and is easy to get wrong: the **agent loop** runs
in a spawned CLI subprocess, but **tool handlers run in the bot's own process**.
The SDK bridges tool calls back across that boundary. That is what lets the tools
keep closing over live state — the logged-in `discord.js` client in
`tools/discord-send.js` and the cached `googleapis` auth in `tools/gdrive.js`
work unchanged. A stdio MCP server would have broken both.

## Files

| File | Change |
|---|---|
| `src/agent.js` | **New.** Agent SDK implementation of `chat()`. Signature-compatible with `claude.js`. |
| `src/tools/mcp.js` | **New.** Wraps the PACKS tools as an in-process SDK MCP server, one per project, cached. |
| `src/tools/zod-schema.js` | **New.** Runtime JSON Schema → Zod converter. |
| `src/tools/index.js` | Added `getProjectToolBindings()` — definitions pre-paired with handlers. Nothing else touched. |
| `src/tools/image.js` | Exported `downloadBuffer()` so `agent.js` can base64 Discord images. |
| `src/handlers/message.js` | Picks a backend from `USE_AGENT_SDK`. Everything below the import is unchanged. |
| `src/claude.js` | **Untouched.** Still the default path. |
| `package.json` | `@anthropic-ai/sdk` **0.39 → 0.112** (forced), plus `@anthropic-ai/claude-agent-sdk` and `zod`. |

### Why schemas are converted at runtime

The SDK's `tool()` accepts only Zod — raw JSON Schema is rejected. Rather than
hand-porting 22 schemas (~250 lines of duplicate definition that would silently
drift), `zod-schema.js` converts them at startup. **PACKS in `tools/index.js`
stays the single source of truth**: add a tool there and it works on both paths
with no second definition to maintain.

## Behavioural differences

| | Messages API (default) | Agent SDK (`USE_AGENT_SDK=1`) |
|---|---|---|
| Prompt caching | Hand-placed `cache_control` breakpoints | Automatic; breakpoints not needed |
| Turn cap | `MAX_TOOL_CALLS` (exact tool-call count) | `maxTurns` — looser, one turn may hold several parallel calls |
| Token cap | `MAX_TOKENS_PER_TURN` | **No equivalent.** Use `MAX_BUDGET_USD` instead |
| Cost | Not reported | `total_cost_usd`, shown in the usage footer |
| History | In-memory array per channel | In-memory SDK session per channel |
| History on restart | Lost | Lost (same) |
| Images | Passed as CDN URL | Downloaded + base64 (URLs are **not** accepted) |
| Tool error | Throws, kills the turn | Returned as `isError`; Claude can recover |
| Process | One | Plus a `claude` CLI subprocess per turn |

## Safety posture

Deliberate choices worth not undoing:

- **Only three SDK built-ins are enabled — `Read`, `Grep`, `Glob` — and only
  read-only ones.** They add what the bot genuinely lacked: real search.
  `list_directory` lists one directory at a time, so finding a symbol across the
  repo previously meant a chain of `read_file` calls. Everything that *writes*
  stays with the bot's own tools, which pin paths via `safeResolve()`.
- **`Write`, `Edit`, and `Bash` are never enabled.** `Bash` in particular would
  give anyone who can `@mention` the bot a shell on the host.
- **`cwd` is set to the project's `repoPath`, and that is load-bearing.** The
  built-ins are scoped by `cwd`, which defaults to the bot's *own* process
  directory — one level above the checkout (`repoPath` defaults to `./repo`) and
  the directory holding `.env`, `google-credentials.json`, and `projects.json`.
  Setting `cwd` is what keeps their reach equivalent to `safeResolve()`'s rather
  than a way around it. **Enabling a built-in without setting `cwd` would point
  it at the bot's own credentials.**
- **A missing repo drops the built-ins rather than falling back.** If
  `cloneRepoIfNeeded()` failed at startup and the bot kept serving other
  projects, `workspaceFor()` returns no `cwd` *and* no built-ins — a broken repo
  loses search instead of gaining reach. Verified against a missing path, a null
  path, and a path that is a file rather than a directory.
- **`allowedTools`** lists exactly the bot's 22 tools, so they auto-approve;
  `canUseTool` denies anything else, so an unexpected tool fails closed.
- **`permissionMode: 'bypassPermissions'` is NOT used.** It appears in a lot of
  SDK examples. It would defeat both of the above.
- **`systemPrompt` is a plain string**, which fully replaces Claude Code's
  default prompt. The `{type:'preset'}` form would layer a coding-agent persona
  on top of the bot's own, and preset sections cannot be selectively removed.
- `safeResolve()` was verified to still block `../../../etc/passwd` through the
  MCP wrapper.

## Multiple repos, and how the SDK path handles them

`projects.json` routes by channel as well as by guild, so one server can work on
several repos — `#app-dev` on the phone app, the rest of the server on the web
app. See `projects.example.json` for the config; what matters here is that the
SDK path needed **no changes at all** to support it.

Routing resolves *before* a backend is chosen. A message picks exactly one
project, and `chat(project, ...)` receives it the way it always did:

```
message → getProjectForChannel(guildId, channelId) → one project
                                                      ├─ claude.js  (Messages API)
                                                      └─ agent.js   (Agent SDK)
```

So everything the SDK path already builds per project is per repo for free, and
stays separated:

| Per-project thing | Effect with several repos |
|---|---|
| `getMcpServer(project)`, cached by `project.id` | Each repo gets its own MCP server and tool set |
| `cwd: project.repoPath` | `Read`/`Grep`/`Glob` bounded to *that* repo's checkout |
| `getSystemPrompt(project)` | Each repo can have its own persona |
| `toolPacks` | The phone app can drop `gdrive`/`todo`/`discord` |

The `cwd` line is worth being explicit about: each project has its own checkout
under `REPO_ROOT`, so the built-in file tools in an `#app-dev` conversation are
bounded to the phone app's tree and **cannot read the web app's** — the same
boundary `safeResolve()` gives the bot's own tools, applied per conversation
rather than globally.

Sessions are keyed by Discord channel and channel routing is what selects the
project, so a channel's session and its repo cannot drift apart.

**What this does not do** is let one conversation touch two repos. That would
need a `repo` parameter on every filesystem and git tool, `safeResolve()` called
against a set of roots, and the SDK's `additionalDirectories` option so the
built-ins could span checkouts. Not built, and not needed for split-by-channel.

## What the SDK path unlocks that the Messages API path can't do

None of this is wired up — the migration deliberately kept behaviour identical.
But these become one-option changes in `agent.js` once the SDK path is proven,
and none of them were reachable from the hand-rolled loop.

**External MCP servers.** `mcpServers` takes a union of four transports, not
just the in-process one this repo uses:

| Transport | Config | Use for |
|---|---|---|
| `sdk` (in-process) | `createSdkMcpServer(...)` | What `tools/mcp.js` does today |
| `stdio` | `{command, args, env}` | A local MCP server run as a subprocess |
| `http` | `{type:'http', url, headers}` | A remote MCP server |
| `sse` | `{type:'sse', url, headers}` | A remote MCP server over SSE |

So the bot could talk to established MCP servers — GitHub, Linear, Notion,
Figma, Context7 — alongside its own tools, with `headers` carrying auth. The
Messages API path had no MCP client at all, so this is genuinely new capability
rather than a reshuffle.

**The rest of the built-in toolset.** The SDK also ships `Write`, `Edit`,
`Bash`, `WebSearch`, and `WebFetch` beyond the three read-only ones enabled
here. `Bash` should stay off permanently; `Write`/`Edit` are redundant with
`write_file` and would need the same `cwd` scoping to be safe — see Safety
posture above.

**Subagents, skills, plugins.** `agents`, `skills`, and `plugins` options exist
and are unused.

> ⚠️ **Adding any of these means extending the allowlist.** `allowedTools` lists
> exactly the bot's 22 tools and `canUseTool` denies everything else, so a newly
> added MCP server's tools will be *denied at call time* until its
> `mcp__<server>__*` names are added too. That is the fail-closed behaviour
> working, not a bug — but it will look like the server silently doesn't work.
>
> Also worth thinking through before connecting a third-party MCP: anyone who
> can `@mention` the bot gets indirect access to whatever that server can do.

## Enabling and rolling back

```bash
# on
USE_AGENT_SDK=1

# off — full rollback, no redeploy of code needed
USE_AGENT_SDK=
```

Nothing else changes. If the SDK path misbehaves in production, unset the
variable and the bot is back on the loop that has been running all along.

## Verification status

Verified in this environment, without credentials:

- Both backends import cleanly against `@anthropic-ai/sdk` 0.112 (the forced bump).
- All 22 tools convert to Zod and build into an MCP server.
- Zod schemas accept valid input and reject missing required fields.
- A tool handler executes through the MCP wrapper and returns correct content blocks.
- `safeResolve()` still blocks path escapes through the wrapper.
- Tool-pack filtering still works (`files,git` → 8 tools).

**NOT verified — needs a real run:**

- A full `query()` turn against the Anthropic API. No API key was available.
- Image handling end to end (Discord attachment → base64 → model).
- Session resume across messages in a channel.
- The `PreToolUse` hook actually driving the live progress message.
- `summarizeIncompleteTask()` on the SDK path (needs a real cap hit).
- Memory headroom for the CLI subprocess on the deployed instance.
- **That `cwd` actually bounds `Read`/`Grep`/`Glob` at runtime.** The scoping
  logic and its fail-closed fallback are tested, but no live turn has confirmed
  the SDK honours `cwd` as the boundary. Worth an explicit first check in a real
  channel: ask the bot to read `../.env` and confirm it cannot.

Treat the SDK path as untested-in-production until someone exercises it in a
real channel. That is what the flag is for.

## Open questions

- **Memory.** A `claude` CLI subprocess per turn on a small Render instance is
  the most likely thing to bite. Worth watching before making the flag default.
- **Session durability.** Currently `InMemorySessionStore`, matching today's
  behaviour. If conversations should survive restarts, swap in a Redis or S3
  `SessionStore` in `agent.js` — that's the one-line hook for it.
- **Whether to converge.** Once the SDK path is proven, the built-in `Read`,
  `Write`, and `Grep` could replace some custom filesystem tools — but only with
  a path-scoping story at least as strong as `safeResolve()`. Not obviously worth
  it.
