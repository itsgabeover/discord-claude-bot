import { gdriveAppendDoc, findDocsByName } from './gdrive.js';

const TODO_DOC_ID = process.env.TODO_DOC_ID;
const TODO_DOC_NAME = process.env.TODO_DOC_NAME || 'todo';

// Resolved doc ID, cached for the process lifetime so filing a task doesn't
// cost a Drive lookup every time. Cleared only by a restart, which is the same
// lifetime as the rest of the bot's state.
let resolvedDocId = null;

/**
 * Work out which doc to append to.
 *
 * Prefers an explicit TODO_DOC_ID, then falls back to finding a Google Doc in
 * the configured folder whose name contains TODO_DOC_NAME ("todo" by default).
 * The fallback exists so a new deployment works after creating a doc, with no
 * ID to copy anywhere — but an explicit ID still wins, because name matching
 * gets ambiguous the moment someone adds "todo ideas — archive".
 *
 * @returns {Promise<{id: string} | {error: string}>}
 */
async function resolveTodoDoc() {
  if (TODO_DOC_ID) return { id: TODO_DOC_ID };
  if (resolvedDocId) return { id: resolvedDocId };

  let matches;
  try {
    matches = await findDocsByName(TODO_DOC_NAME);
  } catch (err) {
    return { error: `Could not search Drive for a todo doc: ${err.message}` };
  }

  if (matches.length === 0) {
    return {
      error:
        `No Google Doc with "${TODO_DOC_NAME}" in its name was found in the Drive folder. ` +
        'Create one (gdrive_create_doc works) and try again, or set TODO_DOC_ID. ' +
        'Tell the user the task was not saved — do not claim it was captured.',
    };
  }

  if (matches.length > 1) {
    const names = matches.map((m) => `"${m.name}" (${m.id})`).join(', ');
    return {
      error:
        `Found ${matches.length} candidate todo docs: ${names}. ` +
        'Ask the user which to use and set TODO_DOC_ID to it. ' +
        'The task was not saved.',
    };
  }

  resolvedDocId = matches[0].id;
  console.log(`[todo] using Drive doc "${matches[0].name}" (${resolvedDocId})`);
  return { id: resolvedDocId };
}

/**
 * Append a task to the project's shared todo document.
 *
 * Deliberately a Google Doc rather than a file in the repo: capturing an idea
 * shouldn't produce a commit, and on a repo wired to a host that builds on push,
 * every captured idea would otherwise burn a deployment. A Doc is also readable
 * by teammates who don't have repo access.
 *
 * @param {string} task - One-line summary of the work
 * @param {object} [options]
 * @param {string} [options.notes] - Context: what's involved, why it was deferred
 * @param {string} [options.requestedBy] - Who asked for it
 */
export async function addTodo(task, { notes, requestedBy } = {}) {
  if (!task || !task.trim()) {
    return 'Cannot add an empty todo — provide a one-line summary of the task.';
  }

  const doc = await resolveTodoDoc();
  if (doc.error) return doc.error;

  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [`- [ ] ${task.trim()}`];
  if (notes && notes.trim()) lines.push(`    ${notes.trim()}`);
  lines.push(`    (added ${stamp}${requestedBy ? ` · requested by ${requestedBy}` : ''})`);

  const result = await gdriveAppendDoc(doc.id, `\n${lines.join('\n')}`);

  // gdriveAppendDoc returns a human-readable string; surface failures verbatim
  // rather than reporting success the caller can't verify.
  if (typeof result === 'string' && /error/i.test(result)) {
    // A stale cached ID (doc deleted or renamed) should not poison every later
    // call — drop it so the next attempt re-resolves by name.
    if (!TODO_DOC_ID) resolvedDocId = null;
    return `Failed to save the todo: ${result}`;
  }
  return `Added to the todo doc:\n${lines.join('\n')}`;
}
