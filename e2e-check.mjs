/**
 * One-shot manual check: run the plugin's `run()` directly against a repo, so
 * the FIXED code path can be exercised without waiting for a host reload.
 *
 * Usage:
 *   node e2e-check.mjs <repo-dir> [message] [tag]
 */
import { run } from './index.js'

const [dir, message, tag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: node e2e-check.mjs <repo-dir> [message] [tag]')
  process.exit(2)
}

const request = { action: 'apply', cwd: dir, push: false }
if (message !== undefined) request.message = message
if (tag !== undefined) request.tag = tag

// No agent and no `get`: the hardest possible caller. This is the state that
// used to drop an explicitly requested tag on the floor.
const ctx = { get: () => undefined }
const result = await run(ctx, request, undefined)

console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
