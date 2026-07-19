import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
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
 * Called when a chat() turn hits a safety cap (tool calls or token budget)
 * before Claude reached a final answer. Rather than a canned "try again"
 * message, ask Claude itself — with the full history of what it already
 * did — to summarize progress and propose concrete, ready-to-send
 * follow-up prompts. `tools` is omitted so this call can't chain further
 * tool use; it's forced to answer in text.
 */
async function summarizeIncompleteTask(history, reason, tokensSoFar) {
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
      system: await getSystemPrompt(),
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
export async function chat(channelId, text, images = [], username = 'User', onToolCall) {
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
  }

  userContent.push({
    type: 'text',
    text: `**${username}:** ${text}`,
  });

  history.push({ role: 'user', content: userContent });

  // Agentic loop — keep going until Claude gives a final text response
  let toolCallCount = 0;
  let totalTokens = 0;

  while (toolCallCount < MAX_TOOL_CALLS && totalTokens < MAX_TOKENS_PER_TURN) {
    console.log(`[claude] channel=${channelId} sending ${history.length} messages to Claude`);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: await getSystemPrompt(),
      tools: toolDefinitions,
      messages: history,
    });

    const { input_tokens = 0, output_tokens = 0 } = response.usage ?? {};
    totalTokens += input_tokens + output_tokens;
    console.log(`[claude] channel=${channelId} usage: +${input_tokens} in / +${output_tokens} out (${totalTokens} total this turn)`);

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
        const result = await executeTool(block.name, block.input);

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
    return summarizeIncompleteTask(history, 'tool call limit', totalTokens);
  }
  if (totalTokens >= MAX_TOKENS_PER_TURN) {
    return summarizeIncompleteTask(history, 'token budget for this turn', totalTokens);
  }
  return '*(unexpected end of response)*' + usageFooter(totalTokens);
}
