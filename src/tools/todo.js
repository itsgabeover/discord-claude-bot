import { gdriveAppendDoc } from './gdrive.js';

const TODO_DOC_ID = process.env.TODO_DOC_ID;

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

  if (!TODO_DOC_ID) {
    return [
      'TODO_DOC_ID is not configured, so there is nowhere to file this.',
      'Create a doc with gdrive_create_doc, then set TODO_DOC_ID to its file ID',
      'and restart. Until then, tell the user the task was not saved — do not',
      'claim it was captured.',
    ].join(' ');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [`- [ ] ${task.trim()}`];
  if (notes && notes.trim()) lines.push(`    ${notes.trim()}`);
  lines.push(`    (added ${stamp}${requestedBy ? ` · requested by ${requestedBy}` : ''})`);

  const result = await gdriveAppendDoc(TODO_DOC_ID, `\n${lines.join('\n')}`);

  // gdriveAppendDoc returns a human-readable string; surface failures verbatim
  // rather than reporting success the caller can't verify.
  if (typeof result === 'string' && /error/i.test(result)) {
    return `Failed to save the todo: ${result}`;
  }
  return `Added to the todo doc:\n${lines.join('\n')}`;
}
