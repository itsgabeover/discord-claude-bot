import * as messagesApi from '../claude.js';
import * as agentSdk from '../agent.js';
import { getProjectForVoiceChannel } from '../config.js';
import { startSession, getSession, stopSession } from '../voice/session.js';
import { turnLimiter } from '../concurrency.js';

/**
 * Joins and leaves voice channels as people come and go.
 *
 * Discord has no way to "invite" a bot into a voice channel — bots join
 * programmatically — so presence is driven by watching voiceStateUpdate. When
 * someone enters a channel listed in a project's voiceChannelIds, the bot joins
 * and greets; when the last human leaves, it disconnects.
 *
 * Only mapped channels count. getProjectForVoiceChannel has no guild fallback,
 * so an unlisted channel is silently ignored and the bot never turns up
 * uninvited in a social call.
 */

const USE_AGENT_SDK = /^(1|true|yes)$/i.test(process.env.USE_AGENT_SDK || '');
// Both backends export the same pair, so voice never learns which one it got.
const { chat: rawChat, clearHistory } = USE_AGENT_SDK ? agentSdk : messagesApi;

/**
 * A voice turn costs the same subprocess a text turn does, so it shares the
 * process-wide cap — otherwise a busy voice channel could sit outside the
 * limit and reintroduce exactly the concurrency the cap exists to bound.
 *
 * Wrapped here, at the single point where chat is injected into the session,
 * rather than at the two call sites inside voice/session.js — the session
 * treats chat as an opaque dependency, and keeping it that way means a future
 * call site is covered automatically.
 *
 * No queue notice: there is nowhere to show one mid-conversation, and a spoken
 * "you're #2 in line" would be worse than the short silence it explains.
 */
const chat = async (...args) => {
  const release = await turnLimiter.acquire();
  try {
    return await rawChat(...args);
  } finally {
    release();
  }
};

/** Humans currently in a channel — the bot itself never counts. */
function humanCount(channel) {
  if (!channel) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

export async function handleVoiceStateUpdate(oldState, newState) {
  const botId = newState.client.user.id;
  if (newState.id === botId || oldState.id === botId) return; // ignore our own moves

  const left = oldState.channelId && oldState.channelId !== newState.channelId
    ? oldState.channel
    : null;
  const joined = newState.channelId && oldState.channelId !== newState.channelId
    ? newState.channel
    : null;

  if (joined) {
    const project = getProjectForVoiceChannel(joined.id);
    if (project && !getSession(joined.guild.id)) {
      console.log(
        `[voice-state] ${newState.member?.displayName || 'someone'} joined ` +
          `"${joined.name}" — starting ${project.id} session.`,
      );
      try {
        await startSession({ project, voiceChannel: joined, chat, clearHistory });
      } catch (err) {
        console.error(`[voice-state] Could not start session: ${err.message}`);
      }
    }
  }

  if (left) {
    const session = getSession(left.guild.id);
    // Only leave the channel the bot is actually sitting in, and only once the
    // last person is gone — otherwise one person leaving a group call would
    // end the conversation for everyone still in it.
    if (session && session.voiceChannel.id === left.id && humanCount(left) === 0) {
      console.log(`[voice-state] "${left.name}" is empty — leaving.`);
      stopSession(left.guild.id);
    }
  }
}
