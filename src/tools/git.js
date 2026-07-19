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
      await git.pull();
      console.log('[git] Pull complete.');
    } catch (err) {
      console.warn(`[git] Pull failed (continuing anyway): ${err.message}`);
    }
    return;
  }

  console.log(`[git:${project.id}] Cloning ${repoUrl} into ${project.repoPath}...`);
  try {
    const authUrl = getAuthenticatedUrl(project);
    await simpleGit().clone(authUrl, project.repoPath);
    await ensureGitIdentity(getGit(project), project);
    console.log('[git] Clone complete.');
  } catch (err) {
    console.error(`[git] Clone failed: ${err.message}`);
    throw err;
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

    // Set the authenticated remote before pushing
    const authUrl = getAuthenticatedUrl(project);
    await git.remote(['set-url', 'origin', authUrl]);
    await git.push('origin', branch);

    return `Pushed to GitHub (branch: ${branch}) — Vercel will deploy automatically.`;
  } catch (err) {
    return `Error pushing to GitHub: ${err.message}`;
  }
}

export async function gitPull(project) {
  try {
    const git = getGit(project);
    const result = await git.pull();

    if (result.files.length === 0) {
      return 'Already up to date — no changes pulled.';
    }

    return `Pulled latest changes:\n${result.files.map(f => `  • ${f}`).join('\n')}`;
  } catch (err) {
    return `Error pulling from GitHub: ${err.message}`;
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
