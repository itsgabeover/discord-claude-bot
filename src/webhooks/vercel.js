/**
 * Handle an incoming Vercel webhook event.
 * Returns a formatted Discord message string, or null if the event is ignored.
 *
 * Vercel sends a JSON body with a `type` field like "deployment.created".
 * Docs: https://vercel.com/docs/webhooks
 */
export function handleVercelEvent(type, payload) {
  const deployment = payload?.deployment ?? payload?.data?.deployment ?? payload;
  const name = deployment?.name ?? payload?.projectMeta?.name ?? 'your project';
  const url = deployment?.url ? `https://${deployment.url}` : null;
  const inspectorUrl = deployment?.inspectorUrl ?? null;
  const branch = deployment?.meta?.githubCommitRef ?? deployment?.gitBranch ?? null;
  const commitMsg = deployment?.meta?.githubCommitMessage ?? null;

  switch (type) {
    case 'deployment.created':
      return [
        `🚀 **Vercel** started deploying **${name}**${branch ? ` (\`${branch}\`)` : ''}`,
        commitMsg ? `> ${commitMsg.split('\n')[0]}` : '',
        inspectorUrl ? `[View build logs](${inspectorUrl})` : '',
      ].filter(Boolean).join('\n');

    case 'deployment.succeeded':
      return [
        `✅ **Vercel** deployment succeeded for **${name}**${branch ? ` (\`${branch}\`)` : ''}`,
        url ? `Live at: ${url}` : '',
        inspectorUrl ? `[View deployment](${inspectorUrl})` : '',
      ].filter(Boolean).join('\n');

    case 'deployment.error':
    case 'deployment.failed': {
      const errorStep = payload?.deployment?.errorStep ?? null;
      const errorMsg  = payload?.deployment?.errorMessage ?? null;
      return [
        `❌ **Vercel** deployment failed for **${name}**${branch ? ` (\`${branch}\`)` : ''}`,
        errorStep ? `Step: ${errorStep}` : '',
        errorMsg  ? `Error: ${errorMsg}` : '',
        inspectorUrl ? `[View build logs](${inspectorUrl})` : '',
      ].filter(Boolean).join('\n');
    }

    case 'deployment.canceled':
      return `🚫 **Vercel** deployment cancelled for **${name}**${branch ? ` (\`${branch}\`)` : ''}`;

    case 'deployment.ready':
      // "ready" is sent when a preview deployment is ready (same as succeeded for previews)
      return [
        `✅ **Vercel** preview ready for **${name}**${branch ? ` (\`${branch}\`)` : ''}`,
        url ? url : '',
      ].filter(Boolean).join('\n');

    default:
      return null; // ignore project.created, domain.verified, etc.
  }
}

/**
 * Handler for POST /webhooks/vercel.
 * Vercel doesn't use HMAC secrets by default but sends a configurable token
 * in the Authorization header that you can check optionally.
 */
export function vercelWebhookHandler(rawBody, authHeader, sendNotification) {
  // Optional token check
  const expectedToken = process.env.VERCEL_WEBHOOK_TOKEN;
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    console.warn('[webhook/vercel] Token mismatch — ignoring request');
    return { status: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON' };
  }

  const type = payload?.type;
  if (!type) return { status: 400, body: 'Missing event type' };

  const message = handleVercelEvent(type, payload);
  if (message) {
    sendNotification(message).catch(err =>
      console.error('[webhook/vercel] Failed to send Discord message:', err)
    );
  }

  return { status: 200, body: 'ok' };
}
