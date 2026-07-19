# CLAUDE.md

Guidance for Claude Code working in this repository.

# Discord Claude Bot

A Discord bot that gives Claude a body: it reads and writes files in a project
repo, commits and pushes, searches the web, reads Google Drive, processes
images, and holds spoken conversations in voice channels. One process serves
several projects across several Discord servers.

Deployed on Render, which auto-deploys from `main`.

## Architecture

```
Discord message ─→ handlers/message.js ─→ getProjectForChannel() ─→ one project
                                                                     ├─ claude.js  (Messages API, default)
                                                                     └─ agent.js   (Claude Agent SDK, opt-in)
                                                                          └─ 22 tools, grouped into packs
Voice join ──────→ handlers/voice-state.js ─→ getProjectForVoiceChannel() ─→ voice/session.js
```

**Routing resolves before anything else.** A message or voice join picks exactly
one project, and everything downstream — tools, repo root, system prompt, token
— comes from it. This is why adding a backend or a tool never has to think about
multi-tenancy: it already received the answer.

| File | Role |
|---|---|
| `src/config.js` | Resolves projects from `projects.json` (or env). The routing tables live here. |
| `src/claude.js` | Hand-rolled agentic loop over the Messages API. The default backend. |
| `src/agent.js` | Same contract, implemented on the Claude Agent SDK. Opt-in via `USE_AGENT_SDK=1`. |
| `src/tools/index.js` | `PACKS` — the single source of truth for every tool definition and handler. |
| `src/tools/mcp.js` | Wraps those same tools as an in-process MCP server for the SDK path. |
| `src/voice/session.js` | Live voice conversation: listen → transcribe → answer → speak. |

## Things that will bite you

These are load-bearing and not obvious from reading a single file.

**`projects.json` is gitignored and lives on Render as a Secret File.** It holds
repo URLs and live GitHub tokens. It is not in the repo and never should be. If
it is missing, the bot silently falls back to single-project mode from env vars
— which has **no guild gate at all** and will answer in every server it has been
invited to, using the default project's repo and push credentials.

**Routing is fail-closed, deliberately.** Text: channel match → guild default →
*no response*. Voice: channel match → *nothing*, with no guild fallback at all,
because joining a voice channel is not an explicit request the way a message is.
Conflicting config (two projects claiming one channel, two guild defaults) is a
startup error rather than an arbitrary pick — guessing wrong means pushing to
the wrong repo.

**Never let the GitHub token reach the checkout.** `git remote set-url` and
`git clone` both persist whatever URL they are given into `.git/config`, which
sits inside the repo root where `read_file` could return it — anyone able to
mention the bot could have it print the token into Discord. Push and pull pass
an authenticated URL *per call*; `origin` holds only the plain URL, startup
scrubs any credential left in an existing checkout, and error text is redacted
before being returned (git puts the remote URL in failure messages, and those
strings go back to Claude and into the channel).

**`safeResolve()` is the file boundary.** Every path a tool touches goes through
it with the project's `repoPath` as an explicit root — it refuses to run without
one, because guessing could resolve against the wrong project's checkout. It
also blocks any path through `.git`. On the SDK path, `cwd` is set to the same
`repoPath`; without it the built-in `Read`/`Grep`/`Glob` would default to the
bot's own directory, which holds `.env`, `google-credentials.json`, and
`projects.json`. If the checkout is missing, the built-ins are dropped entirely
rather than falling back.

**Process-wide mutable state is a cross-server bug.** A turn is long and
asynchronous, so anything stored in a module-level variable gets overwritten by
a message arriving in another server mid-turn. Voice state was exactly this and
is now keyed by project. `project.id` is the finest granularity available at
tool-call time — both backends pass handlers `(input, project)` and nothing
narrower.

**`npm run smoke` exists because a load-time check missed a real outage.** A
call site was renamed without its import; the module still imported fine and
`typeof handleMessage === 'function'` was still true, but every message died
with a `ReferenceError` and the bot was silent in production for half an hour.
The smoke test *invokes* the handler and fails on `ReferenceError`/`TypeError`,
tolerating environmental errors so it runs without credentials. **Run it before
merging anything that touches `handlers/` or `config.js`.**

**Tool packs affect answer quality, not just cost.** Definitions sit in the
cached prefix so they are nearly free in tokens; the real cost is decision
quality. A model choosing among 22 tools when 8 are irrelevant picks worse.

## Commands

```bash
npm start          # run the bot
npm run dev        # run with --watch
npm run smoke      # invoke handleMessage with a fake message; catches wiring bugs
```

There is no test suite beyond the smoke test.

## Deployment and debugging

Render service `srv-d9drupb7uimc73c439h0`. The Render CLI is installed and
authenticated — use it instead of asking for pasted logs:

```bash
render logs --resources srv-d9drupb7uimc73c439h0 --limit 200 --confirm -o json
render deploys list srv-d9drupb7uimc73c439h0 --confirm
```

Log output is **concatenated JSON objects**, not NDJSON — parse with
`json.JSONDecoder().raw_decode()` in a loop, and sort by timestamp (the API does
not return them in order).

Lines worth grepping: `[config]` (which mode and how many projects), `[msg]`
(which project a channel resolved to), `[git`, `[voice`, `[stt`.

A healthy boot looks like:

```
[config] Multi-project mode: 3 project(s) — ...
[msg] Claude backend: Messages API
[git] Clone complete.   ×3
✅ Bot is online as claudebot#3953
```

**Deploys briefly run two instances**, and both connect to Discord's gateway, so
a message during the overlap is processed twice. Harmless for reads; avoid
prompting the bot mid-deploy if it might commit.

## Current state

Working in production: multi-project routing, the text path, all 22 tools,
prompt caching, per-project GitHub tokens, and the **Agent SDK backend** —
`USE_AGENT_SDK=1` is set on Render and the boot log reads `[msg] Claude
backend: Agent SDK`. Images, session resume, and the `cwd` boundary have still
not been deliberately exercised; see `AGENT-SDK-MIGRATION.md`.

**Voice conversation works end to end** as of 2026-07-19 — a full round trip is
in the logs: speech → `[stt]` transcript → model turn → `[voice] Got N bytes of
audio` → played in the channel.

Getting there needed **two independent settings on the ElevenLabs key**, and
fixing one leaves the other failing in a way that looks like the whole feature
is broken:

- **A credit quota above zero**, or TTS returns 401 `quota_exceeded`. This is a
  limit set per *key*, so the account balance can be healthy while the key is
  capped at 0 — which is exactly what happened, and why an earlier note here
  recorded "the balance is at zero". The balance was fine; the key's quota
  wasn't.
- **The `speech_to_text` permission**, or STT returns 401 `missing_permissions`
  and the bot hears nothing. Note that ElevenLabs also offers *speech to
  speech*, which is voice conversion and not a substitute — the pipeline needs
  text in the middle to feed the model.

Known rough edges, none of them blocking:

- **~10 seconds of dead air** between an utterance ending and the reply
  playing. Most of it is the fixed ~23k-token prefix (system prompt + 22 tool
  definitions) on every turn, not accumulated history — a fresh session already
  costs 23k before anyone speaks. Trimming tool packs for voice is the lever
  that matters; capping history is worth doing but is the smaller term.
- **No addressing check.** Any speech in a mapped channel becomes a full model
  turn and a spoken reply, including conversations not directed at the bot.
- **Voice history is unbounded within a session.** `MAX_STORED_SESSIONS` bounds
  how many channels stay resident, but nothing bounds the length of one
  conversation.

Other notes:

- `projects.json` is read once at startup (`config.js:35`), so
  editing the secret file on Render does nothing until the service restarts.
  The startup banner prints a `voice:` line per project — that is the way to
  confirm a mapping actually loaded, since an unmapped voice channel and a
  failed config load are indistinguishable from the outside: both are silence.

Known outstanding:

- Rotate `GITHUB_TOKEN` — it was readable from inside the bot before the fix landed.
- Deliberately deferred: a review gate (`requireReview` → push to a branch and
  open a PR instead of `main`), and per-user push permissions. Neither is built.
  Discord channel permissions are currently the *only* access control — there is
  no per-user check anywhere.
