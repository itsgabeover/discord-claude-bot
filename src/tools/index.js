import { readFile, writeFile, listDirectory } from './filesystem.js';
import { gitStatus, gitCommit, gitPush, gitPull, gitLog } from './git.js';
import { gdriveList, gdriveRead, gdriveCreateDoc, gdriveAppendDoc, gdriveProcessImage } from './gdrive.js';
import { listChannels, sendToChannel } from './discord-send.js';
import { processImage, inspectImage } from './image.js';
import { webSearch } from './web.js';
import { runNpm } from './npm.js';
import { speakInVoice, leaveVoice } from './voice.js';
import { addTodo } from './todo.js';

export { setDiscordClient } from './discord-send.js';
export { setVoiceChannel } from './voice.js';

/**
 * Tools are grouped into packs so a deployment can run only what it needs.
 *
 * The cost of an unused pack is not really tokens — the definitions sit in the
 * cached prefix, so they're billed at a fraction of input price after the first
 * request in a turn. The cost is decision quality: a model choosing among 21
 * tools when 8 are irrelevant to the project picks worse than one choosing
 * among 13. Disabling what a project doesn't use makes the rest work better.
 *
 * Each pack is self-contained — `tools` are the definitions sent to Claude,
 * `handlers` map each tool name to the function that runs it. Adding a pack
 * means adding one entry here; nothing else in the codebase needs to know.
 */
const PACKS = {
  // ── Filesystem ──────────────────────────────────────────────────────────
  files: {
    description: 'Read and write files in the project repo.',
    tools: [
      {
        name: 'read_file',
        description: "Read a file in the project repo. Always do this before editing a file so you know what's already there.",
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path from the repo root, e.g. "src/app/page.tsx"' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file in the project repo. Creates missing parent directories automatically.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path from the repo root.' },
            content: { type: 'string', description: 'The full file content to write.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_directory',
        description: 'List files and folders in a directory of the project repo.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the directory. Defaults to repo root.' },
          },
          required: [],
        },
      },
    ],
    handlers: {
      read_file: (i, p) => readFile(i.path, p.repoPath),
      write_file: (i, p) => writeFile(i.path, i.content, p.repoPath),
      list_directory: (i, p) => listDirectory(i.path || '.', p.repoPath),
    },
  },

  // ── Git ─────────────────────────────────────────────────────────────────
  git: {
    description: 'Inspect, commit, and push changes to the project repo.',
    tools: [
      {
        name: 'git_status',
        description: 'Show which files have been changed in the project repo.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'git_commit',
        description: 'Stage all changed files and commit them. Always commit before pushing.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Descriptive commit message, e.g. "Add character gallery page"' },
          },
          required: ['message'],
        },
      },
      {
        name: 'git_push',
        description: 'Push committed changes to the remote. If the project auto-deploys from its default branch, this ships the change. Always commit first.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'git_pull',
        description: 'Pull the latest changes from the remote. Do this at the start of any coding task.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'git_log',
        description: 'Show recent commit history.',
        input_schema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of commits to show (default 5).' },
          },
          required: [],
        },
      },
    ],
    handlers: {
      git_status: (i, p) => gitStatus(p),
      git_commit: (i, p) => gitCommit(i.message, p),
      git_push: (i, p) => gitPush(p),
      git_pull: (i, p) => gitPull(p),
      git_log: (i, p) => gitLog(i.limit, p),
    },
  },

  // ── npm ─────────────────────────────────────────────────────────────────
  npm: {
    description: 'Run whitelisted npm commands — build, lint, install. Node/JS projects only.',
    tools: [
      {
        name: 'run_npm',
        description: 'Run a safe npm command in the project repo — install packages, build, lint, or type-check. Use after making code changes to verify nothing is broken before committing.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The npm command to run, e.g. "npm run build" or "npm install framer-motion"' },
          },
          required: ['command'],
        },
      },
    ],
    handlers: {
      run_npm: (i, p) => runNpm(i.command, p.repoPath),
    },
  },

  // ── Web search ──────────────────────────────────────────────────────────
  web: {
    description: 'Search the web for research and factual questions.',
    tools: [
      {
        name: 'web_search',
        description: 'Search the web for inspiration, market research, competitor analysis, pricing, or any factual question.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for.' },
            count: { type: 'number', description: 'Number of results to return (max 10, default 5).' },
          },
          required: ['query'],
        },
      },
    ],
    handlers: {
      web_search: (i) => webSearch(i.query, i.count),
    },
  },

  // ── Image processing ────────────────────────────────────────────────────
  media: {
    description: 'Turn image uploads into web-ready assets — resize, convert, cut out backgrounds.',
    tools: [
      {
        name: 'inspect_image',
        description: 'Get the dimensions, format, and file size of an image URL — useful for checking a source file before deciding how to process it.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL of the image to inspect.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'process_image',
        description: 'Download an image from a URL, resize it, convert its format, and save it into the repo. Great for turning design-tool exports into web-optimised assets. Recommended format: webp.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL of the source image.' },
            output_path: { type: 'string', description: 'Where to save it in the repo, e.g. "public/images/logo.webp"' },
            width: { type: 'number', description: 'Max width in pixels (optional, preserves aspect ratio).' },
            height: { type: 'number', description: 'Max height in pixels (optional, preserves aspect ratio).' },
            format: { type: 'string', description: 'Output format: webp (default), png, jpg, avif.' },
            quality: { type: 'number', description: 'Quality 1–100 (default 85).' },
            tint: { type: 'string', description: 'Apply a color tint, as a hex color like "#4A90D9" (optional).' },
            remove_background: { type: 'boolean', description: 'Knock a flat background out to transparent and trim to the subject. Use for logos, product shots, and character art that arrives on white or paper. Requires webp or png.' },
            background_tolerance: { type: 'number', description: 'How far a pixel may drift from the sampled backdrop and still count as background (default 22). Raise if texture survives, lower if the subject gets eaten.' },
          },
          required: ['url', 'output_path'],
        },
      },
    ],
    handlers: {
      inspect_image: (i) => inspectImage(i.url),
      process_image: (i, p) => processImage(i.url, i.output_path, {
        repoPath: p.repoPath,
        width: i.width,
        height: i.height,
        format: i.format,
        quality: i.quality,
        tint: i.tint,
        remove_background: i.remove_background,
        background_tolerance: i.background_tolerance,
      }),
    },
  },

  // ── Google Drive ────────────────────────────────────────────────────────
  gdrive: {
    description: 'Read and write docs and assets in a shared Google Drive folder.',
    tools: [
      {
        name: 'gdrive_list',
        description: 'List files in the configured Google Drive folder — docs, reference material, assets, etc.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'gdrive_read',
        description: 'Read a Google Doc, Sheet, or text file from the configured Drive folder.',
        input_schema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'File ID from gdrive_list results.' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'gdrive_create_doc',
        description: 'Create a new Google Doc in the configured Drive folder. Good for specs, notes, meeting minutes, copy drafts.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Document name, e.g. "Project Brand Guide"' },
            content: { type: 'string', description: 'Text content to put in the document.' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'gdrive_append_doc',
        description: 'Append text to the end of an existing Google Doc.',
        input_schema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'File ID from gdrive_list results.' },
            content: { type: 'string', description: 'Text to append.' },
          },
          required: ['file_id', 'content'],
        },
      },
      {
        name: 'gdrive_process_image',
        description: "Download an image file from the configured Drive folder, resize it, convert its format, and save it into the repo. Use gdrive_list first to find the file's ID. Recommended format: webp.",
        input_schema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'File ID from gdrive_list results.' },
            output_path: { type: 'string', description: 'Where to save it in the repo, e.g. "public/images/logo.webp"' },
            width: { type: 'number', description: 'Max width in pixels (optional, preserves aspect ratio).' },
            height: { type: 'number', description: 'Max height in pixels (optional, preserves aspect ratio).' },
            format: { type: 'string', description: 'Output format: webp (default), png, jpg, avif.' },
            quality: { type: 'number', description: 'Quality 1–100 (default 85).' },
            tint: { type: 'string', description: 'Apply a color tint, as a hex color like "#4A90D9" (optional).' },
            remove_background: { type: 'boolean', description: 'Knock a flat background out to transparent and trim to the subject. Use for logos, product shots, and character art that arrives on white or paper. Requires webp or png.' },
            background_tolerance: { type: 'number', description: 'How far a pixel may drift from the sampled backdrop and still count as background (default 22). Raise if texture survives, lower if the subject gets eaten.' },
          },
          required: ['file_id', 'output_path'],
        },
      },
    ],
    handlers: {
      gdrive_list: (i, p) => gdriveList(p.driveFolderId),
      gdrive_read: (i) => gdriveRead(i.file_id),
      gdrive_create_doc: (i, p) => gdriveCreateDoc(i.name, i.content, p.driveFolderId),
      gdrive_append_doc: (i) => gdriveAppendDoc(i.file_id, i.content),
      gdrive_process_image: (i, p) => gdriveProcessImage(i.file_id, i.output_path, {
        repoPath: p.repoPath,
        width: i.width,
        height: i.height,
        format: i.format,
        quality: i.quality,
        tint: i.tint,
        remove_background: i.remove_background,
        background_tolerance: i.background_tolerance,
      }),
    },
  },

  // ── Todo capture ────────────────────────────────────────────────────────
  todo: {
    description: 'File work for later instead of starting it. Requires TODO_DOC_ID and the gdrive pack.',
    tools: [
      {
        name: 'add_todo',
        description: [
          'Record a task in the shared todo doc instead of doing it now.',
          'Use when a request is too large to finish in one go, is blocked on a decision',
          'only a human can make, or the user asks you to note it for later.',
          'Always confirm with the user before filing something they asked you to build —',
          'offer the choice, do not silently defer work.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'One-line summary of the work, phrased as an action.' },
            notes: { type: 'string', description: 'Optional context: what it involves, why it was deferred, files affected.' },
            requested_by: { type: 'string', description: "Optional: the Discord username of whoever asked for it." },
          },
          required: ['task'],
        },
      },
    ],
    handlers: {
      add_todo: (i, p) => addTodo(i.task, { notes: i.notes, requestedBy: i.requested_by }, p),
    },
  },

  // ── Discord ─────────────────────────────────────────────────────────────
  discord: {
    description: 'Send messages to other channels in the Discord server.',
    tools: [
      {
        name: 'list_channels',
        description: 'List all text channels in the Discord server with their IDs. Use this to find a channel ID before sending a message.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'send_to_channel',
        description: 'Send a message to a specific Discord channel. Use list_channels first to get the channel ID. Good for announcements like "the site just deployed" or notifying a teammate about something.',
        input_schema: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'Discord channel ID (from list_channels).' },
            message: { type: 'string', description: 'The message to send.' },
          },
          required: ['channel_id', 'message'],
        },
      },
    ],
    handlers: {
      list_channels: () => listChannels(),
      send_to_channel: (i) => sendToChannel(i.channel_id, i.message),
    },
  },

  // ── Voice ───────────────────────────────────────────────────────────────
  voice: {
    description: 'Speak out loud in a Discord voice channel. Requires ELEVENLABS_API_KEY.',
    tools: [
      {
        name: 'speak_in_voice',
        description: [
          'Convert text to speech using ElevenLabs and play it in the voice channel the user is currently in.',
          'Use this when the user is in a voice channel and you want to respond verbally — for example when asked a question while on a call.',
          'Keep the text natural and conversational — avoid markdown, code blocks, bullet points, and URLs since they sound awkward when spoken.',
          'If ELEVENLABS_API_KEY is not configured this will return an error.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'What to say out loud. Plain conversational text only — no markdown, no code blocks.',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'leave_voice',
        description: 'Disconnect the bot from the voice channel immediately. Use if the bot gets stuck or the user asks it to leave.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ],
    handlers: {
      speak_in_voice: (i) => speakInVoice(i.text),
      leave_voice: () => leaveVoice(),
    },
  },
};

const ALL_PACKS = Object.keys(PACKS);

/**
 * Resolve a project's pack list. `null`/empty means every pack, so a project
 * that doesn't care about packs behaves the way the bot did before they existed.
 */
function resolvePacks(project) {
  const requested = project.toolPacks;
  if (!requested || !requested.length) return ALL_PACKS;

  const unknown = requested.filter((p) => !ALL_PACKS.includes(p));
  if (unknown.length) {
    console.warn(
      `[tools:${project.id}] Ignoring unknown pack(s): ${unknown.join(', ')}. ` +
        `Available: ${ALL_PACKS.join(', ')}`,
    );
  }

  const enabled = requested.filter((p) => ALL_PACKS.includes(p));
  if (!enabled.length) {
    console.warn(`[tools:${project.id}] No known packs matched — loading all packs.`);
    return ALL_PACKS;
  }

  if (enabled.includes('todo') && !enabled.includes('gdrive')) {
    console.warn(
      `[tools:${project.id}] The 'todo' pack needs 'gdrive' to store tasks — ` +
        'add_todo will fail at call time.',
    );
  }
  return enabled;
}

// Built once per project rather than per request: the definitions are identical
// on every call, and a stable array keeps the prompt prefix byte-identical,
// which is what makes it cacheable.
const perProject = new Map();

function build(project) {
  const packs = resolvePacks(project);
  const tools = packs.flatMap((p) => PACKS[p].tools);
  const handlers = Object.assign({}, ...packs.map((p) => PACKS[p].handlers));
  console.log(
    `[tools:${project.id}] ${tools.length} tools from ${packs.length} pack(s): ${packs.join(', ')}`,
  );
  return { packs, tools, handlers };
}

function forProject(project) {
  let built = perProject.get(project.id);
  if (!built) {
    built = build(project);
    perProject.set(project.id, built);
  }
  return built;
}

/** Tool definitions to send to Claude for this project. */
export function getToolDefinitions(project) {
  return forProject(project).tools;
}

/**
 * A project's tool definitions already paired with their handlers.
 *
 * The Messages API path keeps the two apart on purpose — Claude receives the
 * definitions, and executeTool() routes calls back to the handlers by name. An
 * SDK MCP tool binds both halves into a single object at construction time, so
 * ./mcp.js needs them pre-paired. Same PACKS data either way; only the shape
 * differs.
 *
 * @param {object} project - Resolved project config
 * @returns {Array<{definition: object, handler: Function}>}
 */
export function getProjectToolBindings(project) {
  const { tools, handlers } = forProject(project);
  return tools.map((definition) => ({
    definition,
    handler: handlers[definition.name],
  }));
}

/** Names and descriptions of every pack — for docs and debugging. */
export function listPacks(project) {
  const enabled = project ? forProject(project).packs : ALL_PACKS;
  return ALL_PACKS.map((name) => ({
    name,
    description: PACKS[name].description,
    toolCount: PACKS[name].tools.length,
    enabled: enabled.includes(name),
  }));
}

/** Route a tool call from Claude to the right function, scoped to a project. */
export async function executeTool(name, input, project) {
  const { handlers } = forProject(project);
  const handler = handlers[name];
  if (!handler) {
    const owner = ALL_PACKS.find((p) => PACKS[p].handlers[name]);
    return owner
      ? `Tool "${name}" is in the "${owner}" pack, which is not enabled for this project.`
      : `Unknown tool: ${name}`;
  }
  return handler(input, project);
}
