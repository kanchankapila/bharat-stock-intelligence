import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, sourceMarkers, validateSharedBacklog } from './sharedBacklog.mjs';

const files = collectFiles(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const errors = validateSharedBacklog(files);
if (errors.length) {
  console.error(`[backlog:check] ${errors.length} violation(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[backlog:check] OK: one ledger; ${sourceMarkers(files).length} source markers registered; agent entrypoints linked`);
}
