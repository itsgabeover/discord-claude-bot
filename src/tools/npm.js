import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const REPO_PATH = process.env.REPO_PATH || './repo';

// Only these commands are allowed. Claude cannot run arbitrary shell commands.
const ALLOWED_PATTERNS = [
  /^npm install$/,
  /^npm install ([\w@/.-]+ ?)+$/,
  /^npm ci$/,
  /^npm run (build|lint|test|typecheck|type-check|format|check|dev)$/,
  /^npm (run )?type-?check$/,
  /^npx tsc( --noEmit)?$/,
  /^npx eslint .{1,80}$/,
  /^npx prettier .{1,80}$/,
];

const MAX_OUTPUT_CHARS = 4000;

/**
 * Run a whitelisted npm command in the website repo directory.
 * Returns stdout/stderr so Claude can see errors and fix them.
 */
export async function runNpm(command) {
  const trimmed = command.trim();

  const allowed = ALLOWED_PATTERNS.some(pattern => pattern.test(trimmed));
  if (!allowed) {
    return [
      `"${trimmed}" is not on the allowed list.`,
      '',
      'Allowed commands:',
      '  npm install',
      '  npm install <package>',
      '  npm ci',
      '  npm run build / lint / test / type-check / format / check',
      '  npx tsc --noEmit',
      '  npx eslint <path>',
      '  npx prettier <path>',
    ].join('\n');
  }

  try {
    const { stdout, stderr } = await execAsync(trimmed, {
      cwd: REPO_PATH,
      timeout: 120_000, // 2 minutes max
      env: { ...process.env, FORCE_COLOR: '0' }, // no ANSI codes in output
    });

    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    const result = out || '(command completed with no output)';

    // Truncate very long output (build logs can be huge)
    if (result.length > MAX_OUTPUT_CHARS) {
      return result.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... truncated — ${result.length} chars total]`;
    }

    return result;
  } catch (err) {
    // exec throws on non-zero exit, but stdout/stderr still have useful info
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    const result = out || err.message;

    if (result.length > MAX_OUTPUT_CHARS) {
      return result.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... truncated]`;
    }

    return `Command failed (exit code ${err.code}):\n${result}`;
  }
}
