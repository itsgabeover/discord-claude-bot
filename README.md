# discord-claude-bot 🤖

A collaborative Discord bot powered by Claude (Anthropic) for small teams. Mention it in any channel and it can chat, look at images, read and write files in your project repo, push to GitHub, search the web, and pull from Google Drive.

**Fully customisable** — drop a `system-prompt.md` into the project folder to give the bot personality and context for your specific project. No code changes needed.

---

## How it works

```
Your team in Discord
        │
        ▼
  Claude Bot (Render)  ──── clones / pushes ────▶  GitHub repo
        │                                                │
        ▼                                                ▼
  Anthropic API (Claude)                    Vercel (auto-deploys)
        │
        ▼
  Google Drive (reads your docs)
```

The bot runs on Render. When you mention it, it calls Claude. Claude can read and write files in a local clone of your GitHub repo, then push commits — Vercel picks those up and redeploys your site automatically.

---

## What it does

- **@mention to activate** — only responds when you mention it
- **Full conversation memory** — remembers context within each channel
- **Image understanding** — share screenshots, designs, or photos and it can see them
- **File system access** — reads and writes files in your project repo
- **Git push to deploy** — commits changes and pushes to GitHub, triggering a Vercel redeploy
- **Google Drive** — reads and writes your Docs and Sheets
- **Web search** — looks things up on the web
- **npm runner** — installs packages, builds, lints, and type-checks your project
- **Modular tool packs** — load only the tools your project needs ([details](#tool-packs))
- **Defers big jobs** — offers to file large tasks for later instead of half-shipping them

---

## Prerequisites

- Node.js 18+ (for local dev)
- A Discord account and server
- An [Anthropic API key](https://console.anthropic.com)
- A GitHub account with a repo for your project
- A [Render](https://render.com) account (free tier works)
- A [Vercel](https://vercel.com) account (free tier works)
- (Optional) Google Cloud project for Drive access
- (Optional) [Brave Search API key](https://brave.com/search/api/) for web search

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/itsgabeover/discord-claude-bot.git
cd discord-claude-bot
npm install
```

### 2. Create your project repo on GitHub

```bash
npx create-next-app@latest my-project --typescript --tailwind --app
cd my-project
git init && git add . && git commit -m "Initial Next.js setup"
gh repo create my-project --public --push --source=.
```

### 3. Connect the project repo to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your project's GitHub repo
3. Click Deploy — Vercel will redeploy automatically on every push from now on

### 4. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Give it a name → **Create**
3. Go to **Bot** → **Reset Token** → copy the token (`DISCORD_TOKEN`)
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 → URL Generator**, check **bot**, then check these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Read Message History
6. Copy the generated URL, open it in your browser, and invite the bot to your server

### 5. Create a GitHub Personal Access Token

The bot needs this to push commits from Render to GitHub.

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) → **Generate new token**
2. Give it a name (e.g. `claude-bot`)
3. Under **Repository access**, select your project repo
4. Under **Permissions → Contents**, set to **Read and write**
5. Click **Generate token** and copy it (`GITHUB_TOKEN`)

### 6. Write your system prompt

```bash
cp system-prompt.example.md system-prompt.md
# Open system-prompt.md and describe your project, team, and goals
```

This is what makes the bot feel like it knows your project. See the next section for details.

### 7. (Optional) Google Drive setup

Skip this if you don't need Drive access — the bot works without it.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project
2. Enable the **Google Drive API**
3. Go to **IAM & Admin → Service Accounts** → **Create Service Account**
4. Click the service account → **Keys → Add Key → JSON** → download the file
5. Copy the service account email address
6. Share your Google Drive folder with that email (**Editor** permission for read+write)
7. Copy the folder ID from the URL: `drive.google.com/drive/folders/THIS_PART`

---

## Deploying to Render

1. Push this repo to your own GitHub account:
   ```bash
   gh repo create discord-claude-bot --public --push --source=.
   ```

2. Go to [render.com](https://render.com) → **New → Web Service**

3. Connect your `discord-claude-bot` GitHub repo

4. Configure the service:
   | Setting | Value |
   |---|---|
   | **Environment** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | Free (or Starter for always-on) |

5. Add environment variables (under **Environment**):
   - `DISCORD_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `GITHUB_REPO_URL` — e.g. `https://github.com/yourusername/my-project`
   - `GITHUB_TOKEN`
   - `REPO_PATH` — `./repo`
   - `CLAUDE_MODEL` — `claude-sonnet-4-6`
   - `GOOGLE_DRIVE_FOLDER_ID` (if using Drive)
   - `BRAVE_SEARCH_API_KEY` (if using web search)
   - `NOTIFICATIONS_CHANNEL_ID` (if using webhooks — see below)
   - `GITHUB_WEBHOOK_SECRET` (if using GitHub webhooks)
   - `USE_AGENT_SDK` — leave unset for the default engine; `1` opts into the
     Claude Agent SDK (see [Claude backend](#claude-backend) below)
   - `MAX_BUDGET_USD` — optional; defaults to `1.00` per reply on the Agent SDK path

6. If using Google Drive, go to **Secret Files** and upload your `google-credentials.json` as `./google-credentials.json`

7. If using a custom system prompt, upload your `system-prompt.md` as a Secret File too

8. Click **Create Web Service** — Render will deploy the bot. On first startup it will clone your project repo automatically.

> **Note on Render's free tier:** Free services spin down after 15 minutes of inactivity. The bot will restart on the next Discord message, but there may be a ~30 second delay. Upgrade to the Starter plan ($7/mo) for always-on.

---

## Claude backend

The bot can run its conversation loop on either of two engines. Both use the
same tools and the same system prompt — only the loop around them differs.

| `USE_AGENT_SDK` | Engine | |
|---|---|---|
| unset / `0` | Messages API with the bot's own agentic loop | The default. What has been running in production. |
| `1` | Claude Agent SDK | Opt-in. The SDK owns the loop, prompt caching, turn limits, and cost accounting. |

Switching is entirely an environment change — set the variable, restart, done.
Unsetting it is the rollback; no code change or redeploy of a different commit
is needed either way.

**Try it locally before deploying it.** The SDK path has not been exercised
against a live server:

```bash
USE_AGENT_SDK=1 npm run dev
```

Then in Discord, check the things that differ most from the default path —
share an image (attachments are downloaded and base64-encoded rather than
passed by URL), send two messages in a row (conversation continues via an SDK
session rather than a message array), and ask it to read `../.env` to confirm
the built-in file tools stay inside the project repo.

**On Render**, adding or changing `USE_AGENT_SDK` restarts the service, which
clears conversation history for every channel — the same thing a redeploy does
today. Worth watching memory on the first few turns: the Agent SDK spawns a
bundled `claude` CLI subprocess per turn, which is real extra memory on a free
instance.

See `AGENT-SDK-MIGRATION.md` for the architecture, the behavioural differences,
and what is and isn't verified.

---

## GitHub & Vercel webhook notifications (optional)

When enabled, the bot posts a message in a Discord channel every time someone pushes code, opens a PR, or Vercel finishes a deployment.

### 1. Pick a Discord channel and get its ID

In Discord, enable **Developer Mode** (User Settings → Advanced → Developer Mode), then right-click the channel you want notifications in and choose **Copy Channel ID**. Set that as `NOTIFICATIONS_CHANNEL_ID` in your Render environment.

### 2. Wire up GitHub

1. Go to your project repo on GitHub → **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://your-render-service.onrender.com/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** make up a random string, set it as `GITHUB_WEBHOOK_SECRET` in Render
5. **Events:** choose "Let me select individual events" and tick: **Pushes**, **Pull requests**, **Branch or tag creation**, **Branch or tag deletion**
6. Save — GitHub will send a ping event to confirm it's working

### 3. Wire up Vercel

1. Go to your Vercel project → **Settings → Webhooks → Add Webhook**
2. **URL:** `https://your-render-service.onrender.com/webhooks/vercel`
3. **Events to listen to:** Deployment Created, Deployment Succeeded, Deployment Error
4. Save

> The bot's Render URL is shown on the Render dashboard under your service. It looks like `https://discord-claude-bot-xxxx.onrender.com`.

---

## Usage

In your Discord server, mention the bot:

```
@bot can you build a homepage for the site?
@bot what files are in the repo right now?
@bot check our brand notes in Drive and then update the about page
@bot commit and push what you've done so we can see it live
@bot search for pricing strategies for indie software products
```

Share images in the same message and it can see them too.

### The full coding loop

When you ask the bot to build something, it will:
1. Pull the latest code (`git_pull`)
2. Read existing files to understand what's there
3. Write the new code
4. Run a build check (`npm run build`)
5. Commit the changes (`git_commit`)
6. Push to GitHub (`git_push`)
7. Vercel picks up the push and redeploys — usually live within ~60 seconds

### Special commands

| Command | What it does |
|---|---|
| `@bot !clear` | Clears conversation history for this channel |
| `@bot !history` | Shows how many messages are in memory |

---

## Customising for your project

The bot's personality and project knowledge come entirely from `system-prompt.md` — a plain markdown file you write once and never commit to git.

```bash
cp system-prompt.example.md system-prompt.md
# Open system-prompt.md and fill it in — describe your project, your team,
# your tech stack, and how you want the bot to communicate.
```

That's it. No code changes needed. The bot loads the file on startup and uses it as Claude's instructions for every conversation. `system-prompt.md` is gitignored so your project details stay out of the public repo.

---

## Running several projects from one bot

By default the bot serves one project: one system prompt, one repo, one Drive folder, everything from `.env`. It responds in every server it's in.

To serve **different projects in different Discord servers** from a single process, copy `projects.example.json` to `projects.json` and map each guild ID to its own config:

```json
{
  "projects": {
    "website": {
      "guildId": "111111111111111111",
      "systemPromptPath": "./prompts/website.md",
      "repoUrl": "https://github.com/yourname/website",
      "driveFolderId": "abc123",
      "toolPacks": ["files", "git", "npm", "media", "gdrive", "todo"]
    },
    "game": {
      "guildId": "222222222222222222",
      "systemPromptPath": "./prompts/game.md",
      "repoUrl": "https://github.com/yourname/game",
      "toolPacks": ["files", "git", "web"]
    }
  }
}
```

Each project gets its own **prompt**, **repo checkout** (cloned into `repos/<key>/`), **Drive folder**, **todo doc**, and **tool packs**. Anything you omit falls back to the matching environment variable, so shared settings like `GITHUB_TOKEN` and `GIT_AUTHOR_EMAIL` can stay in `.env`.

**Guilds not listed get no response.** That's deliberate: falling back to a default would mean any server the bot is invited to inherits that project's system prompt and push credentials. The bot replies that it isn't configured for that server, and does nothing else.

The isolation is enforced, not just conventional — file tools resolve paths against their own project's checkout, so one project cannot read or write another's files even with `../` or an absolute path.

### Several repos in one server

Add `channelIds` to a project and it serves only those channels. The entry with *no* `channelIds` is that server's default and handles everything else — so a single server can work on more than one repo:

```json
{
  "projects": {
    "web": {
      "guildId": "111111111111111111",
      "repoUrl": "https://github.com/yourname/wublets-website",
      "toolPacks": ["files", "git", "npm", "web", "media", "gdrive", "todo"]
    },
    "app": {
      "guildId": "111111111111111111",
      "channelIds": ["222222222222222222"],
      "repoUrl": "https://github.com/yourname/wublets-app",
      "toolPacks": ["files", "git", "npm", "web", "media"]
    }
  }
}
```

A message resolves **channel first, then the guild default, then nothing**. So `#app-dev` works on the phone app and every other channel works on the web app. Each still gets its own checkout, prompt, and tool packs — a conversation never spans two repos, which is what keeps the path guard meaningful.

A guild may have at most one default, and no two projects may claim the same channel. Either mistake stops the bot at startup rather than picking arbitrarily. `channelIds` doubles as that project's allowlist, so there's no need to repeat them in `allowedChannelIds`.

> **Watch your GitHub token.** A fine-grained PAT is scoped to specific repositories — one scoped to a single repo can't clone the others, and the bot will fail to prepare them at startup. Either widen the token to every repo, or give each project its own `githubToken`.

> **`projects.json` is gitignored** (it holds repo URLs and can hold tokens), as is `repos/`. A malformed config makes the bot refuse to start rather than silently reverting to single-project mode.

---

## Tool packs

Tools are grouped into **packs** so a deployment can load only what its project needs:

| Pack | Tools | Needs |
|---|---|---|
| `files` | read, write, list files in the repo | — |
| `git` | status, commit, push, pull, log | `GITHUB_TOKEN` |
| `npm` | whitelisted npm commands | a Node/JS project |
| `web` | web search | `BRAVE_SEARCH_API_KEY` |
| `media` | resize/convert images, cut out backgrounds | — |
| `gdrive` | read and write a shared Drive folder | Google credentials |
| `todo` | file work for later instead of building it | `gdrive` pack |
| `discord` | send messages to other channels | — |
| `voice` | speak in a voice channel | `ELEVENLABS_API_KEY` |

By default **every pack loads**. To narrow it, set `ENABLED_TOOL_PACKS` in `.env`:

```bash
# A Python game project with no Drive and no voice
ENABLED_TOOL_PACKS=files,git,web
```

**Why bother?** Not cost — tool definitions live in the cached prompt prefix and bill at a fraction of input price. It's accuracy: a model choosing among 21 tools when 8 are irrelevant to your project picks worse than one choosing among 13. The config above cuts the tool surface by about 64%.

Calling a tool from a disabled pack returns a clear message saying which pack it's in, rather than a generic failure.

---

## Adding new tools

Each pack is one self-contained entry in `src/tools/index.js` — definitions and handlers together — so adding tools means editing one object.

**To add a tool to an existing pack:**

1. **Write the function** in `src/tools/` (an existing file or a new one)
2. **Add its definition** to that pack's `tools` array, and **its handler** to the pack's `handlers` map

**To add a whole new pack**, add one entry to `PACKS`:

```js
const PACKS = {
  // ...
  myservice: {
    description: 'One line shown in docs and startup logs.',
    tools: [
      {
        name: 'my_tool',
        description: 'What it does, and — importantly — when Claude should reach for it.',
        input_schema: {
          type: 'object',
          properties: { thing: { type: 'string', description: 'What this is.' } },
          required: ['thing'],
        },
      },
    ],
    handlers: {
      my_tool: (input) => myFunction(input.thing),
    },
  },
};
```

Nothing else needs to change — the pack shows up in `ENABLED_TOOL_PACKS`, the startup log, and `listPacks()` automatically.

The **description is the most important part**. Be prescriptive about *when* to call the tool, not just what it does — "Call this when the user asks about current prices" beats "Searches for prices." Recent Claude models reach for tools conservatively, and trigger conditions in the description measurably improve how often the right tool gets picked.

### Deferring work instead of doing it

The `todo` pack gives Claude an `add_todo` tool and pairs with scoping rules in `system-prompt.example.md`. The point is that this bot **commits and pushes on its own** — so a task that runs past its tool-call limit halfway through leaves whatever it already pushed live. Triage turns that into a question instead.

Tasks go to a Google Doc rather than a file in the repo, so capturing an idea doesn't produce a commit (and doesn't burn a deploy on repos that build on push). Create a Doc with "todo" in its name in your Drive folder and the bot finds it — or set `TODO_DOC_ID` to pin an exact one.

---

## License

MIT — use it, fork it, make it your own.
