/**
 * Minimal smoke test: does handleMessage actually RUN?
 *
 * Written after a shipped bug that a load-time check could never have caught.
 * message.js called getProjectForChannel() while still importing
 * getProjectForGuild, so the module imported cleanly, `typeof handleMessage`
 * was 'function', and every real message died with a ReferenceError before the
 * bot could reply. The check in place at the time asserted only that the module
 * loaded — which was true, and useless.
 *
 * So this invokes the handler with a fake Discord message and fails on
 * ReferenceError and TypeError specifically: the errors that mean a name or
 * shape is wrong in the code itself. Anything else — an API 401 from a dummy
 * key, a missing repo — is environmental and expected here.
 *
 * Run with: npm run smoke
 */

const failures = [];

function fakeMessage({ guildId = '1', channelId = '2', inVoice = false } = {}) {
  const noop = async () => {};
  return {
    author: { bot: false, username: 'smoke' },
    mentions: { has: () => true },
    client: { user: { id: 'bot' } },
    guildId,
    channelId,
    content: '<@bot> hello',
    attachments: new Map(),
    member: { voice: { channel: inVoice ? { id: 'vc', name: 'General', guild: { id: guildId } } : null } },
    reply: async () => ({ edit: noop }),
    channel: { sendTyping: noop, send: noop },
  };
}

async function run(label, message) {
  const { handleMessage } = await import('../src/handlers/message.js');
  try {
    await handleMessage(message);
    console.log(`  ok    ${label}`);
  } catch (err) {
    if (err instanceof ReferenceError || err instanceof TypeError) {
      console.error(`  FAIL  ${label}: ${err.constructor.name}: ${err.message}`);
      failures.push(label);
    } else {
      // Environmental (bad API key, missing repo) — not what this is testing.
      console.log(`  ok    ${label} (reached ${err.constructor.name}, expected without real credentials)`);
    }
  }
}

console.log('smoke: handleMessage');
await run('plain message', fakeMessage());
await run('message from a user in voice', fakeMessage({ inVoice: true }));
await run('different guild and channel', fakeMessage({ guildId: '999', channelId: '888' }));

if (failures.length) {
  console.error(`\nsmoke FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nsmoke passed');
