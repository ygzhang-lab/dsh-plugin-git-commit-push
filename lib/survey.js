/**
 * One repository survey: everything the plugin needs to describe a changeset,
 * gathered with a fixed, small number of git calls.
 *
 * Nothing in here writes to the repository. The only content it reads are
 * bounded diff samples, which is what keeps a survey cheap enough that a model
 * can afford to call it before every commit.
 */
import {
  currentBranch, git, gitAvailable, hasUpstream, headShort, isRepo,
  numstat, rawDiff, recentSubjects, repoRoot, resolveRepo, status,
} from './git.js'
import {
  VERSION_FILE, buildMessage, declaredSymbols, removedDeclarationCount, scopeOf, typeOfPath,
} from './analyze.js'

/** Git porcelain XY codes collapsed to one display status letter. */
function statusLetter(xy) {
  const index = xy[0]
  const worktree = xy[1]
  if (xy === '??') return '?'
  if (xy === '!!') return '!'
  // `--porcelain=v2` uses '.' for "unchanged"; never let it fall through to 'M'.
  if (index === 'R') return 'R'
  if (index === 'C') return 'C'
  if (index === 'D' || worktree === 'D') return 'D'
  if (index === 'A') return 'A'
  if (index === 'U' || worktree === 'U' || xy === 'AA' || xy === 'DD') return 'U'
  if (worktree === 'M' || index === 'M') return 'M'
  if (index === '.' && worktree === '.') return 'M'
  return 'M'
}

/**
 * Normalize porcelain entries into the plugin's change vocabulary.
 *
 * @param {{ xy: string, path: string, origPath?: string }[]} raw
 * @returns {{ status: string, path: string, staged: boolean, unstaged: boolean, origPath?: string }[]}
 */
export function normalizeEntries(raw) {
  return raw.map(entry => ({
    status: statusLetter(entry.xy),
    path: entry.path,
    staged: entry.xy !== '??' && entry.xy !== '!!' && entry.xy[0] !== ' ' && entry.xy[0] !== '?',
    unstaged: entry.xy === '??' || entry.xy[1] !== ' ',
    ...(entry.origPath === undefined ? {} : { origPath: entry.origPath }),
  }))
}

/**
 * Extract a version string from JSON, TOML, YAML or MSBuild text.
 *
 * The quote handling is load-bearing: in package.json the line is
 * `  "version": "1.1.0",`, so a pattern anchored on a bare `version` key never
 * matches and the tag question would silently never fire for the single most
 * common version-carrying file.
 */
function parseVersion(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    const data = JSON.parse(text)
    if (typeof data?.version === 'string') return data.version
    if (typeof data?.Project?.Version === 'string') return data.Project.Version
  } catch {
    // Not JSON; fall through to the text patterns.
  }
  const patterns = [
    // "version": "1.1.0"   /   version = '1.1.0'   /   version: 1.1.0
    /^\s*["']?version["']?\s*[:=]\s*["']?(v?\d[\w.\-+]*)["']?/mi,
    // MSBuild: <Version>1.1.0</Version>
    /<Version>\s*([\w.\-+]+)\s*<\/Version>/i,
    // Python module dunder: __version__ = "1.1.0"
    /^\s*__version__\s*[:=]\s*["']?(v?\d[\w.\-+]*)["']?/mi,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Detect a version bump by reading both sides from the repository itself.
 *
 * Both sides come from git (`git show HEAD:<f>` and `git show :<f>` — the index),
 * never from the working tree, so an unstaged edit can never be reported as the
 * version being committed, and the two sides are read in exactly the form
 * `git add -A` + commit would use.
 *
 * @returns {Promise<{ file: string, from?: string, to?: string } | undefined>}
 */
async function detectVersion(root, files) {
  for (const file of files) {
    let staged
    try {
      staged = await git(root, ['diff', '--cached', '--no-color', '--', file], { timeoutMs: 15_000 })
    } catch {
      continue
    }
    if (staged.trim() === '') continue

    // Read the staged blob in full rather than rejoining the diff's added lines:
    // a re-joined fragment is not valid JSON, which is exactly how a package.json
    // bump used to be missed.
    const to = parseVersion(await showBlob(root, `:${file}`))
    if (to === undefined) continue
    const from = parseVersion(await showBlob(root, `HEAD:${file}`))
    if (from === to) continue
    return { file, ...(from === undefined ? {} : { from }), to }
  }
  return undefined
}

/** Best-effort read of one blob; undefined when the revision has no such path. */
async function showBlob(root, rev) {
  try {
    return await git(root, ['show', rev], { timeoutMs: 15_000 })
  } catch {
    return undefined
  }
}

/**
 * Read a repository and describe its pending changes.
 *
 * One deliberate side effect: when a version-carrying file is among the
 * changes, that file is staged before the version is read. A version bump is
 * only visible in `git diff --cached`, and this is what lets `prepare` report
 * "1.2.3 → 1.2.4" — and therefore offer the right tag — without a second tool
 * call. The commit path stages everything anyway, so nothing is decided early.
 *
 * @param {object} input
 * @param {string} input.cwd the session working directory
 * @param {string} [input.cwdOverride] an explicit repository path from the caller
 * @param {number} [input.maxFilesShown]
 * @param {'zh' | 'en'} [input.language]
 * @returns {Promise<
 *   | { ok: false, notRepo: true, candidates: string[] }
 *   | { ok: false, notRepo?: false, reason: string, message: string }
 *   | { ok: true, root: string, branch: string, entries: any[], stats: Map<string, any>,
 *       recentSubjects: string[], version?: object, breaking: boolean,
 *       draft: { message: string, type: string, scope?: string, subject: string },
 *       hasUpstream: boolean, head?: string, unifiedDiff: string }
 * >}
 */
export async function survey(input) {
  const { cwd, cwdOverride, language = 'zh', maxFilesShown = 12 } = input

  const resolved = await resolveRepo(cwd, cwdOverride)
  if ('notRepo' in resolved) {
    // "git is not installed" and "this directory is not a repository" are
    // different problems with different fixes; never report one as the other.
    if (!await gitAvailable()) {
      return { ok: false, reason: 'git-unavailable', message: '找不到 git 可执行文件，无法提交。请先安装 Git 并确保它在 PATH 中。' }
    }
    return { ok: false, notRepo: true, candidates: resolved.candidates }
  }
  const root = resolved.root

  const [rawStatus, branch, upstream, head, subjects, diffText] = await Promise.all([
    status(root),
    currentBranch(root),
    hasUpstream(root),
    headShort(root),
    recentSubjects(root, 8),
    rawDiff(root),
  ])

  const entries = normalizeEntries(rawStatus)
  if (entries.length === 0) {
    return { ok: false, reason: 'clean', message: '没有需要提交的改动' }
  }

  const tracked = await numstat(root, false)
  const stats = new Map(tracked)
  for (const entry of entries) {
    if (!stats.has(entry.path)) stats.set(entry.path, { added: 0, deleted: 0, binary: false })
  }

  const breaking = removedDeclarationCount(diffText) > 0
  const versionFiles = entries.map(entry => entry.path).filter(path => VERSION_FILE.test(path))

  // A version bump is only detectable once the file is staged, so stage the
  // version-carrying files and then re-read the index. The commit path stages
  // the whole working tree afterwards, so this never narrows what gets committed.
  let version
  if (versionFiles.length > 0) {
    try {
      await git(root, ['add', '-A', '--', ...versionFiles], { timeoutMs: 20_000 })
    } catch {
      // Best effort: an unstaged version file only means no tag is suggested.
    }
    version = await detectVersion(root, versionFiles)
  }

  const draft = buildMessage({
    entries: entries.map(entry => ({ status: entry.status, path: entry.path, ...(entry.origPath === undefined ? {} : { origPath: entry.origPath }) })),
    stats,
    unifiedDiff: diffText,
    recentSubjects: subjects,
    language,
    maxFiles: maxFilesShown,
  })

  return {
    ok: true,
    root,
    branch,
    entries,
    stats,
    recentSubjects: subjects,
    ...(version === undefined ? {} : { version }),
    breaking,
    draft,
    hasUpstream: upstream,
    ...(head === undefined ? {} : { head }),
    unifiedDiff: diffText,
  }
}

/** Re-exported so callers can classify a path without importing analyze.js. */
export { typeOfPath, scopeOf, declaredSymbols }

/** Whether `dir` is a work-tree root, for the container-cwd error message. */
export { isRepo, repoRoot }
