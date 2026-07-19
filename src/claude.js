import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { getSystemPrompt } from './prompts/system.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);

// Per-channel conversation history: Map<channelId, Message[]>
const histories = new Map();

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
 * @returns {Promise<string>} Claude's final text response
 */
export async function chat(channelId, text, images = [], username = 'User') {
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
  const MAX_TOOL_CALLS = 20; // safety cap

  while (toolCallCount < MAX_TOOL_CALLS) {
    console.log(`[claude] channel=${channelId} sending ${history.length} messages to Claude`);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: await getSystemPrompt(),
      tools: toolDefinitions,
      messages: history,
    });

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
      return textBlocks.map(b => b.text).join('\n').trim() || '*(no text response)*';
    }

    if (response.stop_reason === 'tool_use') {
      // Execute each tool call and collect results
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolCallCount++;

        console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
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

  return toolCallCount >= MAX_TOOL_CALLS
    ? 'I hit the tool call limit on that one — the task might be too complex for a single message. Try breaking it into smaller steps.'
    : '*(unexpected end of response)*';
}
