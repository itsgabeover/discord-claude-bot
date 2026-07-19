import Anthropic from '@anthropic-ai/sdk';
import { getToolDefinitions, executeTool } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);

// Safety caps for a single chat() call's agentic loop — either one stops
// the loop and falls back to summarizeIncompleteTask() below.
const MAX_TOOL_CALLS = parseInt(process.env.MAX_TOOL_CALLS || '30', 10);
const MAX_TOKENS_PER_TURN = parseInt(process.env.MAX_TOKENS_PER_TURN || '150000', 10);

// Per-channel conversation history: Map<channelId, Message[]>
const histories = new Map();

function usageFooter(totalTokens) {
  return `\n\n-# ~${totalTokens.toLocaleString()} tokens this turn`;
}

/**
 * Return `messages` with a cache breakpoint on its final content block, so the
 * whole conversation so far is cached for the next request in the loop.
 *
 * Copies rather than mutating, and deliberately so: the array it receives is
 * the stored per-channel history, which lives for the life of the process. A
 * marker written into it would still be there next iteration, when a different
 * message is last — and the API allows only four breakpoints per request, so
 * after a few tool calls every request would be rejected outright.
 *
 * @param {Array} messages - Stored history; not modified
 * @returns {Array} Copy safe to send
 */
function withCacheBreakpoint(messages) {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) {
    return messages;
  }

  const blocks = last.content.slice();
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral' },
  };

  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * Called when a chat() turn hits a safety cap (tool calls or token budget)
 * before Claude reached a final answer. Rather than a canned "try again"
 * message, ask Claude itself — with the full history of what it already
 * did — to summarize progress and propose concrete, ready-to-send
 * follow-up prompts. `tools` is omitted so this call can't chain further
 * tool use; it's forced to answer in text.
 */
async function summarizeIncompleteTask(history, reason, tokensSoFar, project) {
  try {
    history.push({
      role: 'user',
      content: [{
        type: 'text',
        text: `[SYSTEM NOTE: You've hit this turn's ${reason} and cannot call any more tools right now. Do not attempt to call any tools. Briefly summarize what you completed, what's left, and give the user 2-3 short, ready-to-send follow-up messages that would let you finish the rest across separate turns.]`,
      }],
    });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: await getSystemPrompt(project),
      messages: history,
    });

    history.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const summary = textBlocks.map(b => b.text).join('\n').trim();
    const total = tokensSoFar + (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    return (summary || `I hit this turn's ${reason} — try breaking your request into smaller steps.`)
      + usageFooter(total);
  } catch (err) {
    console.error('[claude] Failed to summarize incomplete task:', err.message);
    return `I hit this turn's ${reason} — the task might be too complex for a single message. Try breaking it into smaller steps.`;
  }
}

export function clearHistory(channelId) {
  histories.delete(channelId);
  return 'Conversation history cleared for this channel.';
}

export function getHistoryLength(channelId) {
  return histories.get(channelId)?.length ?? 0;
}

/**
 * Send a message to Claude and get a response.
 * Handles the full agentic tool-use loop — Claude may call tools
 * multiple times before giving a final text response.
 *
 * @param {string} channelId - Discord channel or thread ID (used as history key)
 * @param {string} text - The user's message text
 * @param {Array<{url: string, contentType: string}>} images - Any image attachments
 * @param {string} username - Discord username for context
 * @param {(name: string, input: object) => void} [onToolCall] - Called right
 *   before each tool executes, so callers can surface live progress. Purely
 *   local bookkeeping over data the loop already has — doesn't add API calls.
 * @returns {Promise<string>} Claude's final text response
 */
export async function chat(project, channelId, text, images = [], username = 'User', onToolCall) {
  if (!histories.has(channelId)) {
    histories.set(channelId, []);
  }
  const history = histories.get(channelId);

  // Build the user message content array
  const userContent = [];

  // Prepend images if any (Claude sees them before the text)
  for (const img of images) {
    userContent.push({
      type: 'image',
      source: {
        type: 'url',
        url: img.url,
      },
    });
    // The URL as text as well as an image block. An image block lets Claude
    // *look* at the attachment; it does not hand over the address. process_image
    // takes a URL, so without this Claude can describe an attached image in
    // detail and still have no way to save it into the repo — which reads to
    // the user as "attachments don't work" when the image plainly arrived.
    userContent.push({
      type: 'text',
      text: `[Attachment URL: ${img.url} — pass this to process_image to save it into the repo.]`,
    });
  }

  userContent.push({
    type: 'text',
    text: `**${username}:** ${text}`,
  });

  history.push({ role: 'user', content: userContent });

  // Agentic loop — keep going until Claude gives a final text response
  let toolCallCount = 0;
  let totalTokens = 0;

  // Read once per turn rather than per iteration. getSystemPrompt() caches
  // internally, but pinning it here also guarantees the prompt can't change
  // mid-turn — a single changed byte would invalidate the cache for every
  // remaining iteration of this loop.
  const systemPrompt = await getSystemPrompt(project);
  const toolDefinitions = getToolDefinitions(project);

  while (toolCallCount < MAX_TOOL_CALLS && totalTokens < MAX_TOKENS_PER_TURN) {
    console.log(`[claude:${project.id}] channel=${channelId} sending ${history.length} messages to Claude`);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // Requests render as tools -> system -> messages, so this single
      // breakpoint covers the tool definitions as well as the prompt. Both are
      // byte-identical on every request, so from the second call onward this
      // whole prefix is a cache read at a fraction of the input price. It
      // matters because a tool-using turn is not one request — it is one per
      // tool call, each resending this same prefix.
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: toolDefinitions,
      // Second breakpoint, moving with the conversation: each iteration reads
      // everything the previous one cached and extends it by a turn.
      messages: withCacheBreakpoint(history),
    });

    const {
      input_tokens = 0,
      output_tokens = 0,
      cache_creation_input_tokens: cacheWrite = 0,
      cache_read_input_tokens: cacheRead = 0,
    } = response.usage ?? {};

    // input_tokens counts only the *uncached* remainder — the cached prefix is
    // reported separately. Summing just input + output would make the turn
    // budget silently balloon as the cache hit rate rises, since most of the
    // prompt would stop being counted at all.
    totalTokens += input_tokens + cacheWrite + cacheRead + output_tokens;
    console.log(
      `[claude:${project.id}] channel=${channelId} usage: +${input_tokens} in / +${output_tokens} out / ` +
        `cache ${cacheRead} read, ${cacheWrite} written (${totalTokens} total this turn)`,
    );

    // Add Claude's response to history
    history.push({ role: 'assistant', content: response.content });

    // Trim history if it's getting too long.
    // Mutate in place (rather than histories.set) so the `history` reference
    // used for the rest of this call stays the same array as the one stored
    // in the Map — otherwise a trim mid-tool-call detaches the two, and the
    // tool_result push below lands on the array nobody reads anymore.
    if (history.length > MAX_HISTORY * 2) {
      // Keep the first message for context, trim the middle
      const trimmed = [history[0], ...history.slice(-(MAX_HISTORY * 2 - 1))];
      history.length = 0;
      history.push(...trimmed);
    }

    if (response.stop_reason === 'end_turn') {
      // Extract text blocks from the final response
      const textBlocks = response.content.filter(b => b.type === 'text');
      const text = textBlocks.map(b => b.text).join('\n').trim() || '*(no text response)*';
      return text + usageFooter(totalTokens);
    }

    if (response.stop_reason === 'tool_use') {
      // Execute each tool call and collect results
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolCallCount++;

        console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
        if (onToolCall) {
          try { onToolCall(block.name, block.input); } catch { /* progress display is best-effort */ }
        }
        const result = await executeTool(block.name, block.input, project);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: String(result),
        });
      }

      // Feed tool results back to Claude
      history.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  if (toolCallCount >= MAX_TOOL_CALLS) {
    return summarizeIncompleteTask(history, 'tool call limit', totalTokens, project);
  }
  if (totalTokens >= MAX_TOKENS_PER_TURN) {
    return summarizeIncompleteTask(history, 'token budget for this turn', totalTokens, project);
  }
  return '*(unexpected end of response)*' + usageFooter(totalTokens);
}
