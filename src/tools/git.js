import simpleGit from 'simple-git';
import fs from 'fs/promises';

function getGit(project) {
  return simpleGit(project.repoPath);
}

/**
 * REPO_PATH on Render is an ephemeral temp directory that's wiped on every
 * redeploy, so git identity can never be set once and persist — it has to
 * be (re)configured locally in the repo on every fresh clone.
 *
 * GIT_AUTHOR_EMAIL must be a verified email on a real GitHub account. Some
 * hosts reject deployments whose commit author doesn't resolve to one — Vercel
 * blocks them outright, which surfaces as "<address> could not be matched to a
 * GitHub account". A made-up address like bot@example.com will fail there. The
 * display name is free-form; only the email needs to be real.
 *
 * There is deliberately no default: committing as whoever the author happened
 * to hardcode is worse than a clear error at startup.
 */
async function ensureGitIdentity(git, project) {
  const name = project.gitAuthorName || 'Claude Bot';
  const email = project.gitAuthorEmail;
  if (!email) {
    throw new Error(
      'GIT_AUTHOR_EMAIL is not set. Set it to a verified email on the GitHub ' +
        'account the bot should commit as — see .env.example.',
    );
  }
  await git.addConfig('user.name', name, false, 'local');
  await git.addConfig('user.email', email, false, 'local');
}

/**
 * Build the authenticated remote URL for pushing/cloning.
 * Uses GITHUB_TOKEN so Render can push without SSH keys.
 */
function getAuthenticatedUrl(project) {
  const url = project.repoUrl;
  const token = project.githubToken;
  if (!url) throw new Error(`No repoUrl configured for project "${project.id}"`);
  if (!token) throw new Error(`No githubToken configured for project "${project.id}"`);

  // Insert token into URL: https://TOKEN@github.com/user/repo.git
  return url.replace('https://', `https://${token}@`);
}

/**
 * Strip the project's token out of anything about to be logged or returned.
 *
 * git puts the remote URL in its error text, so a failed push or pull hands
 * back a message containing `https://TOKEN@github.com/...`. Those strings don't
 * just reach the console — the tool handlers return them to Claude, which
 * relays them into the Discord channel. Every catch block below goes through
 * here for that reason.
 *
 * split/join rather than a regex: tokens can contain regex metacharacters, and
 * a mis-escaped pattern would silently fail to redact.
 */
function redact(text, project) {
  const token = project?.githubToken;
  if (!token || !text) return text;
  return String(text).split(token).join('***');
}

/**
 * Point `origin` at the token-free URL.
 *
 * Both `git clone https://TOKEN@...` and `git remote set-url` persist whatever
 * URL they're given into .git/config — which lives inside the repo root, so the
 * bot's own read_file can reach it and print the token into Discord. Pushing
 * and pulling pass the authenticated URL explicitly instead (see below), so
 * origin never needs to hold the credential.
 *
 * Called after cloning and on every startup pull, so an existing checkout that
 * already has a token baked into its config gets cleaned up rather than staying
 * exposed until the next redeploy.
 */
async function scrubRemote(git, project) {
  if (!project.repoUrl) return;
  try {
    await git.remote(['set-url', 'origin', project.repoUrl]);
  } catch (err) {
    console.warn(`[git:${project.id}] Could not scrub origin: ${redact(err.message, project)}`);
  }
}

/**
 * Called on bot startup. Clones the repo if REPO_PATH doesn't exist yet,
 * or pulls the latest changes if it's already there.
 */
export async function cloneRepoIfNeeded(project) {
  const repoUrl = project.repoUrl;
  if (!repoUrl) {
    console.log(`[git:${project.id}] No repoUrl — skipping clone; file tools use repoPath as-is.`);
    return;
  }

  let exists = false;
  try {
    await fs.access(project.repoPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    console.log(`[git:${project.id}] Repo exists at ${project.repoPath} — pulling...`);
    try {
      const git = getGit(project);
      await ensureGitIdentity(git, project);
      // Heals a checkout cloned before this fix, whose origin still carries a
      // token, before anything else touches it.
      await scrubRemote(git, project);
      const status = await git.status();
      await git.pull(getAuthenticatedUrl(project), status.current);
      console.log('[git] Pull complete.');
    } catch (err) {
      console.warn(`[git] Pull failed (continuing anyway): ${redact(err.message, project)}`);
    }
    return;
  }

  console.log(`[git:${project.id}] Cloning ${repoUrl} into ${project.repoPath}...`);
  try {
    const authUrl = getAuthenticatedUrl(project);
    await simpleGit().clone(authUrl, project.repoPath);
    const git = getGit(project);
    // clone stores the URL it was given as origin, token and all — replace it
    // before the checkout is ever readable by a tool.
    await scrubRemote(git, project);
    await ensureGitIdentity(git, project);
    console.log('[git] Clone complete.');
  } catch (err) {
    console.error(`[git] Clone failed: ${redact(err.message, project)}`);
    throw new Error(redact(err.message, project));
  }
}

export async function gitStatus(project) {
  try {
    const git = getGit(project);
    const status = await git.status();

    if (status.files.length === 0) {
      return 'Git status: working tree clean — nothing to commit.';
    }

    const lines = status.files.map(f => `  ${f.working_dir || f.index} ${f.path}`);
    return `Git status:\n${lines.join('\n')}\n\nBranch: ${status.current}`;
  } catch (err) {
    return `Error getting git status: ${err.message}`;
  }
}

export async function gitCommit(message, project) {
  try {
    const git = getGit(project);
    const status = await git.status();

    if (status.files.length === 0) {
      return 'Nothing to commit — working tree is clean.';
    }

    await ensureGitIdentity(git, project);
    await git.add('.');
    const result = await git.commit(message);

    return `Committed: "${message}"\nCommit hash: ${result.commit}\nFiles changed: ${result.summary.changes}`;
  } catch (err) {
    return `Error committing: ${err.message}`;
  }
}

export async function gitPush(project) {
  try {
    const git = getGit(project);
    const status = await git.status();
    const branch = status.current;

    // Push to the authenticated URL directly rather than storing it as origin.
    // set-url would persist the token into .git/config, where read_file can
    // reach it — the URL passed here lives only for the duration of the call.
    await git.push(getAuthenticatedUrl(project), branch);

    return `Pushed to GitHub (branch: ${branch}) — Vercel will deploy automatically.`;
  } catch (err) {
    return `Error pushing to GitHub: ${redact(err.message, project)}`;
  }
}

export async function gitPull(project) {
  try {
    const git = getGit(project);
    // Same reasoning as gitPush: origin deliberately has no credential, so the
    // authenticated URL is passed per call instead of stored.
    const status = await git.status();
    const result = await git.pull(getAuthenticatedUrl(project), status.current);

    if (result.files.length === 0) {
      return 'Already up to date — no changes pulled.';
    }

    return `Pulled latest changes:\n${result.files.map(f => `  • ${f}`).join('\n')}`;
  } catch (err) {
    return `Error pulling from GitHub: ${redact(err.message, project)}`;
  }
}

export async function gitLog(limit = 5, project) {
  try {
    const git = getGit(project);
    const log = await git.log({ maxCount: limit });
    const lines = log.all.map(c => `• ${c.hash.slice(0, 7)} — ${c.message} (${c.author_name})`);
    return `Recent commits:\n${lines.join('\n')}`;
  } catch (err) {
    return `Error getting git log: ${err.message}`;
  }
}
