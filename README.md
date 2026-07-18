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

6. If using Google Drive, go to **Secret Files** and upload your `google-credentials.json` as `./google-credentials.json`

7. If using a custom system prompt, upload your `system-prompt.md` as a Secret File too

8. Click **Create Web Service** — Render will deploy the bot. On first startup it will clone your project repo automatically.

> **Note on Render's free tier:** Free services spin down after 15 minutes of inactivity. The bot will restart on the next Discord message, but there may be a ~30 second delay. Upgrade to the Starter plan ($7/mo) for always-on.

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

## Adding new tools

The bot is easy to extend. There are always exactly three steps:

1. **Write the function** in `src/tools/` (add to an existing file or create a new one)
2. **Add a tool definition** to the `toolDefinitions` array in `src/tools/index.js` — this is what Claude reads to know the tool exists and how to use it
3. **Add a `case`** to the `executeTool` switch in `src/tools/index.js` to route Claude's call to your function

The description in step 2 is the most important part — write it clearly so Claude knows when and how to use the tool.

---

## License

MIT — use it, fork it, make it your own.
