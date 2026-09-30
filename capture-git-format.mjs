/**
 * Capture byte-exact `git status --porcelain=v1 -z` output from real git in a
 * throwaway repository, so the plugin's two porcelain parsers can be checked
 * against ground truth rather than against a guess about how git frames a
 * rename record.
 *
 * This writes only inside a fresh directory under the OS temp directory, and
 * removes it afterwards. It never touches your repositories.
 *
 * Run it with node (any platform):
 *
 *   node capture-git-format.mjs
 *
 * On Windows with the bundled runtime:
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" capture-git-format.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEV_NULL, numstat, parseStatusZ } from './lib/git.js'

const cwd = mkdtempSync(join(tmpdir(), 'git-commit-push-probe-'))
const GIT_ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: DEV_NULL,
  GIT_CONFIG_SYSTEM: DEV_NULL,
}

function git(args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
}

/** Render a raw string with NULs and newlines visible, for eyeballing. */
function visible(text) {
  return text.replace(/\u0000/g, '\\0').replace(/\n/g, '\\n\n')
}

try {
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'keep.js'), 'export const keep = 1\n')
  writeFileSync(join(cwd, 'src', 'old-name.js'), 'export const moved = 1\n')
  writeFileSync(join(cwd, 'src', 'gone.js'), 'export const gone = 1\n')
  writeFileSync(join(cwd, 'src', '中文.js'), 'export const zh = 1\n')
  git(['add', '-A'])
  git(['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', 'commit', '-q', '-m', 'base'])

  // 1. a plain modification
  writeFileSync(join(cwd, 'src', 'keep.js'), 'export const keep = 2\n')
  // 2. a staged rename
  git(['mv', 'src/old-name.js', 'src/new-name.js'])
  // 3. a deletion
  rmSync(join(cwd, 'src', 'gone.js'))
  // 4. an untracked file
  writeFileSync(join(cwd, 'src', 'brand-new.js'), 'export const fresh = 1\n')
  // 5. a modification to a non-ascii path
  writeFileSync(join(cwd, 'src', '中文.js'), 'export const zh = 2\n')
  // 6. a path containing a space
  writeFileSync(join(cwd, 'src', 'two words.js'), 'export const two = 1\n')

  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])

  console.log('\n=== raw `status --porcelain=v1 -z` output ===\n')
  console.log(visible(raw))

  console.log('\n=== NUL-split tokens (index: value, JSON) ===\n')
  raw.split('\u0000').forEach((token, index) => {
    console.log(`${String(index).padStart(2)}: ${JSON.stringify(token)}`)
  })

  console.log('\n=== what the plugin parses it into ===\n')
  const parsed = parseStatusZ(raw)
  for (const entry of parsed) console.log(`  xy=${JSON.stringify(entry.xy)} path=${JSON.stringify(entry.path)}${entry.origPath === undefined ? '' : ` orig=${JSON.stringify(entry.origPath)}`}`)

  console.log('\n=== `diff --numstat -z HEAD` and the plugin\'s parse ===\n')
  const rawNumstat = git(['diff', '--numstat', '-z', 'HEAD'])
  console.log(visible(rawNumstat))
  const stats = await numstat(cwd, false)
  for (const [path, stat] of stats) console.log(`  ${JSON.stringify(path)} -> +${stat.added}/-${stat.deleted}${stat.binary ? ' binary' : ''}`)

  console.log('\n=== expected shape ===\n')
  console.log('  6 changes: M keep.js, R new-name.js (orig old-name.js), D gone.js,')
  console.log('             ?? brand-new.js, M 中文.js, ?? "two words.js"')
  console.log('\nCompare the two lists above. A rename whose "orig" is missing, or a\npath that swallowed the next entry, means parseStatusZ needs fixing.\n')
} finally {
  rmSync(cwd, { recursive: true, force: true })
  console.log(`cleaned up ${cwd}\n`)
}
