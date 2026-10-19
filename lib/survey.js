/**
 * One repository survey: everything the plugin needs to describe a changeset,
 * gathered with a fixed, small number of git calls.
 *
 * Nothing in here writes to the repository (it may stage the version-carrying
 * files, see `survey` below). The content it reads is bounded: diff samples and
 * the version candidates only, which is what keeps a survey cheap enough that a
 * model can afford to call it before every commit.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  currentBranch, git, gitAvailable, hasUpstream, headShort, isRepo,
  numstat, rawDiff, recentSubjects, repoRoot, resolveRepo, status,
} from './git.js'
import {
  declaredSymbols, isVersionFile, planCommits, removedDeclarationCount, scopeOf, typeOfPath, versionFileRank,
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

/** The key spellings a version is kept under: `version`, `appVersion`, `APP_VERSION`, … */
const VERSION_KEY = '(?:app[_.-]?)?version'

/**
 * A value that looks like a version, not like a port number or a module path.
 * The dot is required: with names as broad as `config.js`, a bare `version: 2`
 * is far more likely to be a schema/API revision than a release version.
 */
const VERSION_VALUE = 'v?\\d+(?:\\.\\d+)+[\\w.\\-+]*'

/** A dotted version, used for JSON values nested below the top level. */
const DOTTED_VERSION = /^v?\d+(?:\.\d+)+/

/**
 * Find a version value anywhere in parsed JSON, closest to the top level first.
 *
 * Nested search is bounded (depth 3) and only accepts string values, so
 * `dependencies` maps and `"version": 2` counters cannot be mistaken for the
 * project version. `package.json`'s top-level `version` still wins because the
 * direct children are scanned before any recursion.
 */
function versionFromJson(value, depth) {
  if (depth > 3 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = versionFromJson(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const keyPattern = new RegExp(`^${VERSION_KEY}$`, 'i')
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string' || !keyPattern.test(key)) continue
    // A top-level `version` is authoritative (package.json may say "1"); nested
    // ones must look like a release version so a `{ "version": 2 }` counter is
    // not mistaken for one.
    const looksLikeVersion = depth === 0 ? /^v?\d/.test(child) : DOTTED_VERSION.test(child)
    if (looksLikeVersion) return child
  }
  for (const child of Object.values(value)) {
    const found = versionFromJson(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Extract a version string from JSON, TOML, YAML, MSBuild, dotenv or JS/TS text.
 *
 * The quote handling is load-bearing: in package.json the line is
 * `  "version": "1.1.0",`, so a pattern anchored on a bare `version` key never
 * matches and the tag question would silently never fire for the single most
 * common version-carrying file. The same is true of `export const APP_VERSION =
 * '1.1.0'` in the settings/config modules backend and frontend projects use.
 */
export function parseVersion(text) {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    const found = versionFromJson(JSON.parse(text), 0)
    if (found !== undefined) return found
  } catch {
    // Not JSON; fall through to the text patterns.
  }
  const patterns = [
    // "version": "1.1.0" · appVersion: '1.1.0' · const APP_VERSION = "1.1.0" · VERSION=1.1.0
    new RegExp(`(?:^|[^\\w$])["']?(?:export\\s+(?:default\\s+)?)?(?:const|let|var)?\\s*["']?${VERSION_KEY}["']?\\s*[:=]\\s*["'\`]?(${VERSION_VALUE})`, 'im'),
    // MSBuild: <Version>1.1.0</Version>
    /<Version>\s*([\w.\-+]+)\s*<\/Version>/i,
    // Python module dunder: __version__ = "1.1.0"
    /^\s*__version__\s*[:=]\s*["']?(v?\d[\w.\-+]*)["']?/mi,
    // dotenv with a conventional upper-case key: VITE_APP_VERSION=1.1.0
    /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*VERSION\s*[:=]\s*["']?(v?\d[\w.\-+]*)["']?/m,
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
  // Manifest first, then version-named files, dotenv, settings/config modules;
  // alphabetical inside a rank so the result is deterministic.
  const ordered = [...files].sort((left, right) =>
    versionFileRank(left) - versionFileRank(right) || left.localeCompare(right))
  for (const file of ordered) {
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
 * Upper bound on a file the probe will read. A settings/config module that big
 * is not a version definition, and reading it would make `prepare` slow.
 */
const VERSION_PROBE_LIMIT = 2 * 1024 * 1024

/**
 * Does this changed file's WORKING-TREE content actually hold a version?
 *
 * The name filter is deliberately broad (`config.js`, `tsconfig.json`,
 * `.vscode/settings.json` all match), and staging every name match would stage
 * files that have nothing to do with the version. This bounded read is what
 * keeps that side effect to files that can produce a version at all.
 *
 * @returns {boolean}
 */
function versionSourceInWorktree(root, file) {
  try {
    // `lstat`, not `stat`: a tracked symlink is never followed, so a `config.js`
    // pointing outside the repository cannot make the survey read anything it
    // would not otherwise touch.
    const stats = lstatSync(join(root, file))
    if (!stats.isFile() || stats.size > VERSION_PROBE_LIMIT) return false
    return parseVersion(readFileSync(join(root, file), 'utf8')) !== undefined
  } catch {
    // Deleted, unreadable, or a symlink: never worth staging.
    return false
  }
}

/**
 * Read a repository and describe its pending changes.
 *
 * One deliberate side effect: when a changed file both looks like a version
 * source by name (`versionFileRank`) and actually contains a version in its
 * working-tree content, that file is staged before the version is read. A
 * version bump is only visible in `git diff --cached`, and this is what lets
 * `prepare` report "1.2.3 → 1.2.4" — and therefore offer the right tag —
 * without a second tool call. The commit path stages everything anyway, so
 * nothing is decided early.
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
 *       draft: { message: string, type: string, scope?: string, subject: string,
 *                notes: { path: string, note: string }[], groups: object[] },
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
  // A name match is only a guess: manifests, `.env` files and any
  // version/setting/config module are candidates, and the bounded content probe
  // keeps the staging side effect to files that can actually produce a version.
  const versionFiles = entries
    .filter(entry => entry.status !== 'D')
    .map(entry => entry.path)
    .filter(path => isVersionFile(path) && versionSourceInWorktree(root, path))

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

  // The plan, not a single message: the changeset is committed as one commit per
  // `type(scope)` group, and `groups` is that plan. `message` remains the
  // whole-changeset message and is what a one-group run commits verbatim.
  const draft = planCommits({
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
