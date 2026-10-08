/**
 * Clear a stale `node_modules/<package>` entry inside a DSH profile.
 *
 * WHY THIS EXISTS — the ERR_PNPM_EPERM install failure
 * pnpm installs a package by building a temporary directory NEXT TO the target
 * (`<target>_tmp_<pid>_<thread>`) and then renaming it onto `<target>`. A rename
 * cannot replace an existing, non-empty directory, so the move fails with EPERM
 * on Windows:
 *
 *   [ERR_PNPM_EPERM] [importPackage …\node_modules\dsh-plugin-git-commit-push]
 *   EPERM: operation not permitted, rename '…<name>_tmp_5280_1' -> '…<name>'
 *
 * Measured on this machine (Node 24, NTFS): renaming onto an existing non-empty
 * directory throws EPERM, and the very same rename succeeds once the destination
 * is gone. pnpm's own recovery path cannot always help, because the classic
 * leftover is a `link:` install — a junction/symlink — whose checkout was later
 * moved or deleted. Removing a dangling link needs an operation pnpm's retry
 * loop swallows, so it retries the rename until it gives up and reports the
 * failure, while the package may already be present enough for DSH to load after
 * a restart. That is exactly the "install failed, but after restarting DSH the
 * plugin shows as installed" report this module answers.
 *
 * WHAT IT DOES
 * Removes the entry so pnpm can import into a clean path. The removal is safe by
 * construction: a symbolic link or junction is UNLINKED, never followed — the
 * checkout it points at keeps every file (verified by the `junction` check in
 * self-test.mjs). A plain directory is removed recursively, which is the only
 * way to clear a destination pnpm no longer tracks.
 *
 * Both installers (setup.ps1, setup.sh) call THIS file rather than each carrying
 * their own copy of the logic, for the same reason they both call
 * `lib/profile-edit.mjs`: a second hand-written implementation would drift, and
 * this is the step that must never delete the wrong directory.
 *
 * Usage:
 *   node lib/profile-link.mjs --profile-dir <dir> --package <name>
 *
 * Prints one stable token on stdout — `absent`, `removed-link`, or
 * `removed-directory` — so the calling script can relay what happened. Exit
 * code 1 means the target path was refused as unsafe and NOTHING was removed.
 */
import { lstatSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Parse `--flag value` pairs without pulling in a dependency. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

/**
 * Whether `child` is strictly inside `parent`.
 *
 * Windows paths are compared case-insensitively; the check exists so that a
 * malformed `--package` can never turn this script into a remover for something
 * outside the profile's own `node_modules`.
 */
function isInside(parent, child) {
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(resolve(parent))
  const full = fold(resolve(child))
  return full.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Remove the profile's `node_modules/<package>` entry when it is in the way.
 *
 * @param {string} profileDir absolute profile directory
 * @param {string} packageName a bare package name (no path separators)
 * @returns {'absent' | 'removed-link' | 'removed-directory'}
 */
export function clearStaleEntry(profileDir, packageName) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(packageName)) {
    throw new Error(`refusing to touch "${packageName}": a package name must be a single path segment`)
  }
  const nodeModules = join(profileDir, 'node_modules')
  const target = join(nodeModules, packageName)
  if (!isInside(nodeModules, target)) {
    throw new Error(`refusing to touch ${target}: it is not inside ${nodeModules}`)
  }

  let stats
  try {
    // lstat, never stat: the question is what the ENTRY is, not what it points at.
    stats = lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }

  if (stats.isSymbolicLink()) {
    // A `link:` install (a symlink on macOS/Linux, a junction on Windows).
    // unlink removes the entry itself; the checkout it points at is untouched.
    unlinkSync(target)
    return 'removed-link'
  }
  if (stats.isDirectory()) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 })
    return 'removed-directory'
  }
  rmSync(target, { force: true })
  return 'removed-directory'
}

/* c8 ignore start -- CLI wiring; the exported helper above is what the tests drive */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  const profileDir = typeof args['profile-dir'] === 'string' ? args['profile-dir'] : undefined
  const packageName = typeof args.package === 'string' ? args.package : undefined
  if (profileDir === undefined || packageName === undefined) {
    console.error('usage: node profile-link.mjs --profile-dir <dir> --package <name>')
    process.exit(2)
  }
  try {
    console.log(clearStaleEntry(profileDir, packageName))
  } catch (error) {
    console.error(`profile-link: ${error.message}`)
    process.exit(1)
  }
}
/* c8 ignore stop */
