import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at moduleUrl is the script Node was started with. Node resolves the main module to its real
// path, so both sides are compared as real paths: run through a symlinked skill folder (~/.claude/skills/qa-gui ->
// ~/.agents/skills/qa-gui) or under macOS /tmp -> /private/tmp, a plain comparison of process.argv[1] with
// import.meta.url never matches and the script would exit 0 without doing anything. Same rule as QA Code's
// isDirectExecution.
export function isDirectExecution(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
