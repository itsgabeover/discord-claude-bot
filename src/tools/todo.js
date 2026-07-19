import { gdriveAppendDoc, findDocsByName } from './gdrive.js';

// Resolved doc IDs, cached per project so filing a task doesn't cost a Drive
// lookup every time. Keyed by project id — two projects have different docs, and
// a single shared variable would serve one project's doc to the other.
const resolvedDocIds = new Map();

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
async function resolveTodoDoc(project) {
  if (project.todoDocId) return { id: project.todoDocId };
  const cached = resolvedDocIds.get(project.id);
  if (cached) return { id: cached };

  const docName = project.todoDocName || 'todo';
  let matches;
  try {
    matches = await findDocsByName(docName, project.driveFolderId);
  } catch (err) {
    return { error: `Could not search Drive for a todo doc: ${err.message}` };
  }

  if (matches.length === 0) {
    return {
      error:
        `No Google Doc with "${docName}" in its name was found in the Drive folder. ` +
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

  resolvedDocIds.set(project.id, matches[0].id);
  console.log(`[todo:${project.id}] using Drive doc "${matches[0].name}" (${matches[0].id})`);
  return { id: matches[0].id };
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
export async function addTodo(task, { notes, requestedBy } = {}, project) {
  if (!task || !task.trim()) {
    return 'Cannot add an empty todo — provide a one-line summary of the task.';
  }

  const doc = await resolveTodoDoc(project);
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
    if (!project.todoDocId) resolvedDocIds.delete(project.id);
    return `Failed to save the todo: ${result}`;
  }
  return `Added to the todo doc:\n${lines.join('\n')}`;
}
