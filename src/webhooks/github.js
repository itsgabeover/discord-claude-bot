import crypto from 'crypto';

/**
 * Verify GitHub's HMAC-SHA256 webhook signature.
 * Returns true if the signature matches (or if no secret is configured).
 */
function verifySignature(secret, rawBody, signatureHeader) {
  if (!secret) return true; // no secret configured — skip verification
  if (!signatureHeader) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/**
 * Handle an incoming GitHub webhook event.
 * Returns a formatted Discord message string, or null if the event is ignored.
 */
export function handleGitHubEvent(event, payload) {
  switch (event) {
    case 'push': {
      // Ignore branch deletions
      if (payload.deleted) return null;

      const branch = payload.ref?.replace('refs/heads/', '') ?? 'unknown';
      const repo = payload.repository?.full_name ?? 'unknown repo';
      const pusher = payload.pusher?.name ?? 'Someone';
      const commits = payload.commits ?? [];
      const compareUrl = payload.compare;

      if (commits.length === 0) return null;

      const commitLines = commits
        .slice(0, 5)
        .map(c => `  • \`${c.id.slice(0, 7)}\` ${c.message.split('\n')[0]}`)
        .join('\n');

      const more = commits.length > 5 ? `\n  …and ${commits.length - 5} more` : '';

      return [
        `📦 **${pusher}** pushed ${commits.length} commit${commits.length === 1 ? '' : 's'} to \`${branch}\` in **${repo}**`,
        commitLines + more,
        compareUrl ? `[View diff](${compareUrl})` : '',
      ].filter(Boolean).join('\n');
    }

    case 'create': {
      if (payload.ref_type !== 'branch' && payload.ref_type !== 'tag') return null;
      const repo = payload.repository?.full_name ?? 'unknown repo';
      const creator = payload.sender?.login ?? 'Someone';
      const icon = payload.ref_type === 'tag' ? '🏷️' : '🌿';
      return `${icon} **${creator}** created ${payload.ref_type} \`${payload.ref}\` in **${repo}**`;
    }

    case 'delete': {
      if (payload.ref_type !== 'branch' && payload.ref_type !== 'tag') return null;
      const repo = payload.repository?.full_name ?? 'unknown repo';
      const deleter = payload.sender?.login ?? 'Someone';
      const icon = payload.ref_type === 'tag' ? '🏷️' : '🌿';
      return `${icon} **${deleter}** deleted ${payload.ref_type} \`${payload.ref}\` in **${repo}**`;
    }

    case 'pull_request': {
      const pr = payload.pull_request;
      const repo = payload.repository?.full_name ?? 'unknown repo';
      const actor = payload.sender?.login ?? 'Someone';

      const icons = { opened: '🔀', closed: pr?.merged ? '✅' : '❌', reopened: '🔄', ready_for_review: '👀' };
      const icon = icons[payload.action] ?? '🔀';
      if (!icons[payload.action]) return null; // ignore synchronize, assigned, etc.

      const status = payload.action === 'closed'
        ? (pr?.merged ? 'merged' : 'closed without merging')
        : payload.action;

      return `${icon} **${actor}** ${status} PR #${pr?.number} in **${repo}**: [${pr?.title}](${pr?.html_url})`;
    }

    case 'issues': {
      if (!['opened', 'closed', 'reopened'].includes(payload.action)) return null;
      const issue = payload.issue;
      const repo = payload.repository?.full_name ?? 'unknown repo';
      const actor = payload.sender?.login ?? 'Someone';
      const icons = { opened: '🐛', closed: '✔️', reopened: '🔄' };
      return `${icons[payload.action]} **${actor}** ${payload.action} issue #${issue?.number} in **${repo}**: [${issue?.title}](${issue?.html_url})`;
    }

    default:
      return null; // ignore everything else (stars, forks, etc.)
  }
}

/**
 * Express-style request handler for /webhooks/github.
 * Works with the raw http.IncomingMessage + parsed body passed from server.js.
 */
export function githubWebhookHandler(event, rawBody, signature, sendNotification) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!verifySignature(secret, rawBody, signature)) {
    console.warn('[webhook/github] Signature mismatch — ignoring request');
    return { status: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON' };
  }

  const message = handleGitHubEvent(event, payload);
  if (message) {
    sendNotification(message).catch(err =>
      console.error('[webhook/github] Failed to send Discord message:', err)
    );
  }

  return { status: 200, body: 'ok' };
}
