/**
 * The only place this plugin talks to git.
 *
 * Design rules that must not be relaxed:
 *
 *  1. FIXED ARGV UP FRONT. Every git invocation is `git -C <root> --no-pager
 *     -c color.ui=false <args...>` with `-c core.quotepath=false` so non-ASCII
 *     paths survive as UTF-8 instead of octal escapes. Arguments are passed as
 *     an argv array (never a shell string), so a path or branch name can never
 *     become a second command.
 *  2. NO DESTRUCTIVE VERBS. `push --force`, `reset --hard`, `clean`,
 *     `checkout --`, `config` and `restore` are absent from this module by
 *     construction. If you need one, it does not belong in this plugin.
 *  3. CAPTURED OUTPUT IS BOUNDED. Every read has a byte cap; a monorepo-sized
 *     diff cannot be pulled into the Host's heap or into the model's context.
 *  4. THE USER'S GIT CONFIG IS NEVER WRITTEN. No `config` call exists here, and
 *     `GIT_OPTIONAL_LOCKS=0` keeps read commands from taking index locks.
 *
 * The pinned commit identity is supplied per command with `-c user.name=...`
 * `-c user.email=...` ONLY when the config asks for it, so a machine without a
 * global identity can still commit without this plugin mutating the user's
 * global or repository configuration.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** A git invocation the plugin refused to run, or that failed. */
export class GitError extends Error {
  constructor(message, code, command, stderr = '') {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.command = command
    this.stderr = stderr
  }
}

/** Upper bound on captured stdout for any single read command. */
const READ_CAP = 1 << 20 // 1 MiB
/** Default budget for a local, non-network command. */
const LOCAL_TIMEOUT_MS = 30_000
/** Push/pull talk to a remote; give them room before giving up. */
const NETWORK_TIMEOUT_MS = 90_000

/**
 * The platform's bit bucket.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are set to this to run git with the
 * user's configuration OUT of the picture. Windows has no `/dev/null` — passing
 * it there is not merely ignored, it makes git look for a file literally named
 * `/dev/null` — so each platform gets its own spelling.
 */
export const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null'

/** Environment that pins a deterministic, user-config-free git. FOR TESTS. */
export function isolatedGitEnv() {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GIT_CONFIG_SYSTEM: DEV_NULL,
  }
}

/**
 * Environment for the plugin's own git calls.
 *
 * Deliberately NOT `isolatedGitEnv()`: the user's global configuration is left
 * in place here, because that is where their credential helper, `pull.rebase`
 * and `core.autocrlf` live. Blanking it would silently change how their own
 * repositories behave — the opposite of this plugin's contract.
 *
 * `LC_ALL=C` is load-bearing: `classifyPushFailure` matches English stderr, and
 * a localized git would report a non-fast-forward rejection as an unknown
 * reason, silently disabling the rebase retry. `GIT_TERMINAL_PROMPT=0` turns a
 * missing credential into a clean failure instead of a hung process waiting on
 * a stdin we never opened.
 */
export function pluginGitEnv() {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/**
 * Run one git command and resolve with raw stdout.
 *
 * @param {string} root repository root (or any dir inside it)
 * @param {readonly string[]} args git arguments, already split
 * @param {{ timeoutMs?: number, identity?: { name?: string, email?: string } }} [options]
 * @returns {Promise<string>} stdout
 */
export function git(root, args, options = {}) {
  const { timeoutMs = LOCAL_TIMEOUT_MS, identity } = options

  const argv = ['-C', root, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=false']
  if (identity?.name !== undefined && identity.name !== '') argv.push('-c', `user.name=${identity.name}`)
  if (identity?.email !== undefined && identity.email !== '') argv.push('-c', `user.email=${identity.email}`)
  argv.push(...args)

  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn('git', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: pluginGitEnv(),
      })
    } catch (error) {
      reject(new GitError(`cannot run git: ${error.message}`, 'git-unavailable', args.join(' ')))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new GitError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'timeout', args.join(' '), stderr))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < READ_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitError(`cannot run git: ${error.message}`, 'git-unavailable', args.join(' '), stderr))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      reject(new GitError(
        stderr.trim() !== '' ? stderr.trim() : `git ${args[0] ?? ''} exited with ${String(code)}`,
        'git-failed',
        args.join(' '),
        stderr,
      ))
    })
  })
}

/**
 * Whether a usable `git` executable exists at all.
 *
 * `isRepo` deliberately swallows every error, which would otherwise report a
 * machine with no git installed as "this project is not a Git repository" — a
 * misleading answer that sends the user looking in the wrong place. This probe
 * tells the two apart.
 */
export async function gitAvailable() {
  // A directory that certainly exists: `git --version` does not read it, but
  // spawn still needs a valid cwd.
  const root = process.platform === 'win32' ? (process.env.SystemRoot ?? process.cwd()) : '/'
  try {
    await git(root, ['--version'], { timeoutMs: 8_000 })
    return true
  } catch (error) {
    return !(error instanceof GitError && error.code === 'git-unavailable')
  }
}

/** Whether `dir` resolves to the top level of a git work tree. */
export async function isRepo(dir, signal) {
  if (signal?.aborted) throw new GitError('aborted', 'aborted', 'rev-parse')
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 8_000 })
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** @returns {Promise<string>} the repository top level containing `dir` */
export function repoRoot(dir) {
  return git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8_000 }).then(out => out.trim())
}

/**
 * Immediate child directories that are themselves work-tree roots.
 *
 * A session whose working directory is a container (a home directory, or a
 * folder of projects) must not be silently committed to. Instead we offer the
 * candidates so the caller can name the repository it meant.
 *
 * @returns {Promise<string[]>} up to 8 candidate repository roots
 */
export async function childRepoRoots(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const roots = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (roots.length >= 8) break
    const candidate = join(dir, entry.name)
    try {
      const out = await git(candidate, ['rev-parse', '--show-toplevel'], { timeoutMs: 4_000 })
      const root = out.trim()
      if (root !== '' && !roots.includes(root)) roots.push(root)
    } catch {
      // Ordinary directory; keep looking.
    }
  }
  return roots
}

/**
 * Resolve the repository this call should operate on.
 *
 * @param {string} cwd the session working directory
 * @param {string | undefined} requested an explicit override from the caller
 * @returns {Promise<{ root: string } | { notRepo: true, candidates: string[] }>}
 */
export async function resolveRepo(cwd, requested) {
  const start = requested !== undefined && requested !== ''
    ? (isAbsolute(requested) ? requested : resolve(cwd, requested))
    : cwd
  if (await isRepo(start)) return { root: await repoRoot(start) }
  return { notRepo: true, candidates: await childRepoRoots(start) }
}

/** The current branch name, or 'HEAD' when detached. */
export async function currentBranch(root) {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

/** Whether the current branch already has an upstream. */
export async function hasUpstream(root) {
  try {
    await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: 8_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse `status --porcelain=v1 -z`.
 *
 * Each record is `XY <path>`; a rename/copy record carries the ORIGIN path as
 * the next NUL field, which must be consumed so it is not mistaken for an entry.
 *
 * @returns {{ xy: string, path: string, origPath?: string }[]}
 */
export function parseStatusZ(raw) {
  const tokens = raw.split('\u0000')
  const entries = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === undefined || token === '') continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    const entry = { xy, path }
    // `-z` reverses the rename pair to `to\0from\0`, and git emits the extra
    // source field whenever a rename_source exists — which includes a
    // WORKTREE-side rename (XY ` R`), not only a staged one. Testing just
    // `xy[0]` would leave `old\0` to be parsed as a bogus entry.
    if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C')
      && tokens[index] !== undefined && tokens[index] !== '') {
      entry.origPath = tokens[index]
      index += 1
    }
    entries.push(entry)
  }
  return entries
}

/** Working-tree status including untracked files, as individual entries. */
export async function status(root) {
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parseStatusZ(raw)
}

/**
 * Per-file line counts for the working tree, staged and unstaged together.
 *
 * `git diff --numstat -z` emits, per record:
 *
 *     added TAB deleted TAB NUL preimage NUL postimage NUL
 *
 * i.e. the counts come FIRST and are followed by the NUL-framed path. For a
 * rename the preimage (old path) precedes the postimage (new path). Every
 * consumer keys this map by the CURRENT path — `survey` fills missing keys from
 * the status entries and the card looks up `stats.get(entry.path)` — so the
 * postimage is the key and the preimage is skipped. Getting this backwards
 * silently loses the line counts of every renamed file.
 *
 * `HEAD` may not exist yet (a repository with no commits), in which case the
 * numstat call is impossible and every entry is reported as new.
 *
 * @returns {Promise<Map<string, { added: number, deleted: number, binary: boolean }>>}
 */
export async function numstat(root, cached) {
  const args = ['diff', '--numstat', '-z']
  if (cached) args.push('--cached')
  args.push('HEAD')
  let raw
  try {
    raw = await git(root, args)
  } catch {
    return new Map()
  }
  const stats = new Map()
  const tokens = raw.split('\u0000')
  let index = 0
  while (index < tokens.length) {
    const header = tokens[index]
    index += 1
    if (header === undefined || header === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(header)
    if (match === null) continue
    let path = match[3]
    if (path === '') {
      // Rename: the next field is the preimage, the one after it is the postimage.
      index += 1
      path = tokens[index] ?? ''
      index += 1
    }
    const added = match[1] === '-' ? 0 : Number(match[1])
    const deleted = match[2] === '-' ? 0 : Number(match[2])
    stats.set(path, { added, deleted, binary: match[1] === '-' || match[2] === '-' })
  }
  return stats
}

/**
 * The raw `--unified=0` working-tree diff, or `''` when it cannot be read.
 *
 * Returns the DIFF TEXT, not a digest of it: the two consumers want different
 * views of the same bytes (`declaredSymbols` looks at added lines,
 * `removedDeclarationCount` at removed declaration lines), so sampling here
 * would either lose information one of them needs or duplicate the parsing.
 *
 * `--no-textconv` matters: a repository with a textconv filter would otherwise
 * run an external command during what is supposed to be a read-only survey.
 *
 * @returns {Promise<string>}
 */
export async function rawDiff(root) {
  try {
    return await git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD'], { timeoutMs: 20_000 })
  } catch {
    // No HEAD yet (a repository with no commits), or the read failed: an empty
    // diff is the honest answer, and callers treat it as "no evidence".
    return ''
  }
}

/**
 * The first `limit` added lines of the working-tree diff, trimmed.
 *
 * Diff *headers* are filtered out so `+++ b/path` can never be mistaken for an
 * added line of content.
 *
 * @returns {Promise<string[]>}
 */
export async function addedLineSample(root, limit = 60) {
  const diff = await rawDiff(root)
  const sample = []
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const text = line.slice(1).trim()
    if (text === '' || text.startsWith('/*') || text.startsWith('*') || text.startsWith('//')) continue
    sample.push(text)
    if (sample.length >= limit) break
  }
  return sample
}

/** Recent commit subjects, newest first, used only to match the repo's tone. */
export async function recentSubjects(root, count = 8) {
  try {
    const raw = await git(root, ['log', '-n', String(count), '--pretty=format:%s'], { timeoutMs: 8_000 })
    return raw.split('\n').filter(line => line !== '')
  } catch {
    return []
  }
}

/** Resolve HEAD's short hash, or undefined in a repository with no commits. */
export async function headShort(root) {
  try {
    return (await git(root, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 8_000 })).trim()
  } catch {
    return undefined
  }
}

/** Stage everything (the working tree) exactly as the skill does. */
export function stageAll(root, signal) {
  if (signal?.aborted) throw new GitError('aborted', 'aborted', 'add')
  return git(root, ['add', '-A'])
}
/** Commit what is staged. `-m` is always passed as its own argv element. */
export async function commit(root, message, identity) {
  return git(root, ['commit', '-m', message], { identity, timeoutMs: 60_000 })
}

/**
 * Validate a user- or caller-supplied tag name.
 *
 * Rejection is deliberate rather than sanitizing: silently rewriting the name
 * the user asked for would create a tag they did not choose. `git check-ref-format`
 * is the authority.
 *
 * @returns {Promise<string | undefined>} an error message, or undefined when valid
 */
export async function tagNameError(root, tag) {
  if (typeof tag !== 'string' || tag.trim() === '') return 'tag name is empty'
  if (tag.startsWith('-')) return 'tag name must not start with "-"'
  if (/\s/.test(tag)) return 'tag name must not contain whitespace'
  try {
    await git(root, ['check-ref-format', `refs/tags/${tag}`], { timeoutMs: 8_000 })
    return undefined
  } catch {
    return `"${tag}" is not a valid git tag name`
  }
}

/** Whether a tag of this name already exists locally. */
export async function tagExists(root, tag) {
  try {
    const out = await git(root, ['tag', '--list', tag], { timeoutMs: 8_000 })
    return out.trim() !== ''
  } catch {
    return false
  }
}

/** Create a lightweight tag. */
export function createTag(root, tag) {
  return git(root, ['tag', tag], { timeoutMs: 15_000 })
}

/**
 * The remote `git push` would use for this branch.
 *
 * Needed because a refspec-ONLY push makes git read the refspec as the REMOTE
 * name: `git push refs/tags/v1.2.3` fails with
 * `fatal: 'refs/tags/v1.2.3' does not appear to be a git repository`, and the tag
 * silently never leaves the machine (measured; see the tag-publishing tests).
 * `%(push:remotename)` is git's own answer to "where would this branch push to",
 * so `branch.<name>.pushRemote`, `remote.pushDefault` and `branch.<name>.remote`
 * are all honoured instead of this file guessing at them.
 *
 * @param {string} root repository directory
 * @param {string} branch branch name (without `refs/heads/`)
 * @returns {Promise<string>} the remote name, falling back to `origin`
 */
export async function pushRemoteFor(root, branch) {
  try {
    const name = (await git(root, ['for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`], { timeoutMs: 8_000 })).trim()
    if (name !== '') return name
  } catch {
    // A repository with no remote configured at all: `origin` is then the name the
    // user is about to create, and the push reports the truth either way.
  }
  return 'origin'
}

/**
 * Push the current branch.
 *
 * With no upstream this uses `-u origin <branch>`; otherwise it is a plain
 * `push`. `tag` pushes exactly that one tag alongside the branch, as a second
 * command, so a tag rejection cannot be confused with a branch rejection.
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, stderr: string, reason: string }>}
 */
export async function push(root, branch, options = {}) {
  const { tag, hasUpstream: upstream = false } = options
  const hasTag = typeof tag === 'string' && tag !== ''
  const args = ['push']
  if (!upstream) {
    args.push('-u', options.remote ?? 'origin', branch)
  } else if (hasTag) {
    // The remote MUST be named here: this command carries no branch refspec, so a
    // lone `refs/tags/<tag>` would be parsed as the remote (see `pushRemoteFor`).
    args.push(options.remote ?? await pushRemoteFor(root, branch))
  }
  if (hasTag) args.push(`refs/tags/${tag}`)
  try {
    await git(root, args, { timeoutMs: NETWORK_TIMEOUT_MS })
    return { ok: true }
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    return {
      ok: false,
      code: error.code ?? 'git-failed',
      stderr,
      reason: classifyPushFailure(stderr) ?? error.message,
    }
  }
}

/** Turn a push failure's stderr into one machine-branchable reason. */
export function classifyPushFailure(stderr) {
  if (stderr === '') return undefined
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(stderr)) return 'non-fast-forward'
  if (/Authentication failed|could not read Username|Permission denied|terminal prompts disabled|HTTP 40[13]|access denied/i.test(stderr)) return 'auth'
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|network/i.test(stderr)) return 'network'
  if (/protected branch|pre-receive hook declined|GH00\d/i.test(stderr)) return 'remote-policy'
  return 'rejected'
}

/**
 * Whether a rebase is currently in progress.
 *
 * Used to honour the promise that this plugin hands the repository back exactly
 * as it found it: `git rebase --abort` must never be aimed at a rebase the user
 * was already in the middle of.
 */
export async function rebaseInProgress(root) {
  try {
    const gitDir = (await git(root, ['rev-parse', '--git-path', 'rebase-merge'], { timeoutMs: 8_000 })).trim()
    if (existsSync(gitDir)) return true
    const applyDir = (await git(root, ['rev-parse', '--git-path', 'rebase-apply'], { timeoutMs: 8_000 })).trim()
    return existsSync(applyDir)
  } catch {
    // Unknown: assume the worst and let the caller refuse to abort.
    return true
  }
}

/**
 * Reconcile a rejected push, then retry it once.
 *
 * Only `pull --rebase` is permitted here. A rebase that cannot finish is
 * aborted so the repository is handed back in the state it was found in — and
 * the abort is only ever issued when THIS function's pull is what started the
 * rebase, so a rebase the user already had running is never discarded.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, stderr?: string, rebased?: boolean }>}
 */
export async function pushAfterRebase(root, branch, options = {}) {
  const first = await push(root, branch, options)
  if (first.ok) return { ok: true, rebased: false }

  if (first.reason !== 'non-fast-forward') {
    return { ok: false, reason: first.reason, stderr: first.stderr }
  }

  // A pre-existing rebase means the pull cannot proceed cleanly anyway, and
  // aborting it would destroy the user's own operation.
  if (await rebaseInProgress(root)) {
    return { ok: false, reason: 'rebase-in-progress', stderr: first.stderr }
  }

  try {
    await git(root, ['pull', '--rebase', '--no-edit'], { timeoutMs: NETWORK_TIMEOUT_MS })
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    const conflict = /CONFLICT|could not apply|Merge conflict/i.test(stderr) || /CONFLICT|Merge conflict/i.test(error.message)
    // Hand the repository back clean — but only for the rebase we started.
    if (await rebaseInProgress(root)) {
      try {
        await git(root, ['rebase', '--abort'], { timeoutMs: 20_000 })
      } catch {
        // The abort failed; the report below is the truth either way.
      }
    }
    return { ok: false, reason: conflict ? 'rebase-conflict' : 'pull-failed', stderr }
  }

  const second = await push(root, branch, options)
  if (second.ok) return { ok: true, rebased: true }
  return { ok: false, reason: second.reason, stderr: second.stderr, rebased: true }
}
