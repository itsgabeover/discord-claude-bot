import http from 'http';
import { githubWebhookHandler } from './github.js';
import { vercelWebhookHandler } from './vercel.js';

let _discordClient = null;

/**
 * Send a notification message to the configured notifications channel.
 * Falls back to a console log if no channel is configured or the send fails.
 */
async function sendNotification(message) {
  const channelId = process.env.NOTIFICATIONS_CHANNEL_ID;
  if (!channelId) {
    console.log('[webhook] No NOTIFICATIONS_CHANNEL_ID set — skipping Discord message');
    return;
  }
  if (!_discordClient) {
    console.warn('[webhook] Discord client not ready yet — skipping Discord message');
    return;
  }

  const channel = await _discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[webhook] Could not find channel ${channelId}`);
    return;
  }

  // Split long messages (Discord 2000 char limit)
  const chunks = [];
  let remaining = message;
  while (remaining.length > 2000) {
    chunks.push(remaining.slice(0, 2000));
    remaining = remaining.slice(2000);
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

/**
 * Read the full raw body from an IncomingMessage.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start the HTTP server that receives GitHub and Vercel webhooks.
 * Render sets the PORT env var; we listen on that port (or 3000 for local dev).
 *
 * Routes:
 *   POST /webhooks/github   — GitHub push / PR / create events
 *   POST /webhooks/vercel   — Vercel deployment events
 *   GET  /health            — health check (Render uses this)
 */
export function startWebhookServer(discordClient) {
  _discordClient = discordClient;

  const PORT = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      console.error('[webhook] Failed to read request body:', err);
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    let result;

    if (url.pathname === '/webhooks/github') {
      const event = req.headers['x-github-event'] ?? '';
      const signature = req.headers['x-hub-signature-256'] ?? '';
      result = githubWebhookHandler(event, rawBody, signature, sendNotification);

    } else if (url.pathname === '/webhooks/vercel') {
      const authHeader = req.headers['authorization'] ?? '';
      result = vercelWebhookHandler(rawBody, authHeader, sendNotification);

    } else {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(result.status, { 'Content-Type': 'text/plain' });
    res.end(result.body);
  });

  server.listen(PORT, () => {
    console.log(`🪝 Webhook server listening on port ${PORT}`);
    console.log(`   POST /webhooks/github  — GitHub events`);
    console.log(`   POST /webhooks/vercel  — Vercel deployment events`);
    if (!process.env.NOTIFICATIONS_CHANNEL_ID) {
      console.warn('   ⚠️  NOTIFICATIONS_CHANNEL_ID not set — webhooks will log but not post to Discord');
    }
  });

  return server;
}
