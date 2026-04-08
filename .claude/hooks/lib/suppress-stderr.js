/**
 * Suppress stderr writes for SessionStart hooks.
 *
 * SessionStart hooks must NEVER write to stderr — Claude Code treats any
 * stderr output as a hard error. Shared libraries (agent-tracker,
 * config-reader, session-queue) legitimately use console.error for
 * non-SessionStart consumers, so we suppress at the process level instead
 * of modifying those shared files.
 *
 * @returns {() => void} Restore function (call to re-enable stderr)
 */
export function suppressStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => { process.stderr.write = orig; };
}
