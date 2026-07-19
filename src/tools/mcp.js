import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { getProjectToolBindings } from './index.js';
import { jsonSchemaToZodShape } from './zod-schema.js';

/**
 * The bot's own tools, exposed to the Agent SDK as an in-process MCP server.
 *
 * "In-process" is the whole reason this migration is cheap: the handlers below
 * are the same functions the Messages API path calls, running in this Node
 * process, so they keep closing over state the tools depend on — the logged-in
 * discord.js client in ./discord-send.js and the cached googleapis auth in
 * ./gdrive.js. A stdio MCP server would have put a process boundary through the
 * middle of both. (The SDK does still spawn a `claude` CLI subprocess to run the
 * agent loop; it bridges tool calls back here rather than executing them there.)
 */

// MCP namespaces every tool as `mcp__<server>__<tool>`. The server name is
// fixed rather than per-project so those fully-qualified names stay identical
// across projects — otherwise the allowedTools list in ../agent.js would have
// to be rebuilt per project for no benefit.
export const SERVER_NAME = 'bot';

const perProject = new Map();

function build(project) {
  const bindings = getProjectToolBindings(project);

  const tools = bindings.map(({ definition, handler }) =>
    tool(
      definition.name,
      definition.description,
      jsonSchemaToZodShape(definition.input_schema),
      async (args) => {
        // Handlers return a plain string; MCP expects content blocks.
        //
        // Failures come back as isError text rather than thrown, which is a
        // deliberate difference from the Messages API path: there, a throw from
        // executeTool() unwinds all the way to the handler in
        // ../handlers/message.js and the whole turn dies with "Something went
        // wrong". Here Claude sees the error as a tool result and can retry,
        // pick a different tool, or explain the problem to the user.
        try {
          const result = await handler(args, project);
          return { content: [{ type: 'text', text: String(result) }] };
        } catch (err) {
          console.error(`[mcp:${project.id}] ${definition.name} failed:`, err.message);
          return {
            content: [{ type: 'text', text: `Error running ${definition.name}: ${err.message}` }],
            isError: true,
          };
        }
      },
    ),
  );

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools,
  });

  const toolNames = bindings.map(({ definition }) => `mcp__${SERVER_NAME}__${definition.name}`);

  console.log(`[mcp:${project.id}] exposed ${toolNames.length} tool(s) as ${SERVER_NAME}`);
  return { server, toolNames };
}

/**
 * Build (once per project) the MCP server and the fully-qualified names of the
 * tools it exposes.
 *
 * Cached for the same reason ./index.js caches its definitions: the tool list
 * is identical on every request, and a stable prefix is what makes the prompt
 * cacheable.
 *
 * @param {object} project - Resolved project config
 * @returns {{server: object, toolNames: string[]}}
 */
export function getMcpServer(project) {
  let built = perProject.get(project.id);
  if (!built) {
    built = build(project);
    perProject.set(project.id, built);
  }
  return built;
}
