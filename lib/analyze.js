/**
 * Change classification and the deterministic Conventional-Commits generator.
 *
 * This module is the "not enough context" fallback: it runs when the caller
 * asks for `auto` mode and is the ONLY path that produces a commit subject
 * without a human or a model writing one. It is deliberately rule-based and
 * never invents a fact it did not observe — when nothing specific can be
 * named it produces an honest, generic subject rather than a plausible lie.
 */

/** Which Conventional Commits type a path most likely belongs to. */
const TYPE_BY_EXTENSION = new Map(Object.entries({
  md: 'docs', mdx: 'docs', rst: 'docs', adoc: 'docs', txt: 'docs',
  css: 'style', scss: 'style', less: 'style', styl: 'style', sass: 'style',
  png: 'chore', jpg: 'chore', jpeg: 'chore', gif: 'chore', svg: 'chore',
  ico: 'chore', webp: 'chore', woff: 'chore', woff2: 'chore', ttf: 'chore',
}))

/** Directories whose name alone implies a type. */
const TYPE_BY_SEGMENT = [
  [/^(tests?|__tests__|spec|e2e)$/i, 'test'],
  [/^(docs?|documentation)$/i, 'docs'],
  [/^(\.github|\.gitlab|\.circleci)$/i, 'ci'],
  [/^\.vscode$/i, 'chore'],
]

/** File names that are build/CI/dependency manifests rather than product code. */
const BUILD_FILE = /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|tsdown\.config\.[cm]?[jt]s|esbuild\.[cm]?[jt]s|bun\.lockb|Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements\.txt|Gemfile(\.lock)?|composer\.(json|lock)|Makefile|Dockerfile|docker-compose\.ya?ml)$/i

/** Test-ish file names. */
const TEST_FILE = /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i

/** Documentation-ish file names. */
const DOC_FILE = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE|AGENTS|CLAUDE)(\.[^/]*)?$|\.(md|mdx|rst)$/i

/** Style-ish file names. */
const STYLE_FILE = /\.(css|scss|less|styl|sass)$/i

/**
 * Known manifests: their top-level version is the project version by convention.
 */
const MANIFEST_FILE = /(^|\/)(package\.json|manifest\.json|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|composer\.json|pubspec\.yaml|pom\.xml|__init__\.py)$/

/** A path with a segment about the version (`version.js`, `VERSION`, `app-version.ts`). */
const VERSION_NAME_FILE = /(^|\/)[^/]*version[^/]*(\/|$)/i

/** dotenv-style files: `.env`, `.env.local`, `env.production`, `env.js`. */
const ENV_FILE = /(^|\/)(\.env(\.[\w.-]+)?|env(\.[\w.-]+)?)(\/|$)/i

/**
 * Settings/config modules, the usual home of a `version`/`appVersion` constant.
 * The SEGMENT is what matches, so `settings/version.js`, `config/index.js`,
 * `src/config/index.js` and a bare `config.js` are all candidates.
 */
const CONFIG_NAME_FILE = /(^|\/)[^/]*(setting|config)[^/]*(\/|$)/i

/**
 * How strongly a changed path's NAME suggests its content carries a version.
 *
 * The plugin cannot afford to read every changed file, and projects keep their
 * version in wildly different places: a manifest, a `.env` file, or a module
 * such as `settings/version.js`, `settings/index.js`, `config/index.js`,
 * `setting.js`, `config.js`. So any file whose name contains
 * version/setting/config is tried, plus dotenv files. Lower rank is tried
 * first, which keeps a real manifest ahead of a `config.js` that happens to
 * contain an unrelated `version` key. `-1` means "not a version candidate".
 *
 * `parseVersion` decides whether the content actually holds a version; a name
 * match alone never produces a tag suggestion.
 */
export function versionFileRank(path) {
  if (MANIFEST_FILE.test(path)) return 0
  if (VERSION_NAME_FILE.test(path)) return 1
  if (ENV_FILE.test(path)) return 2
  if (CONFIG_NAME_FILE.test(path)) return 3
  return -1
}

/** Whether a path is worth probing for a version number at all. */
export function isVersionFile(path) {
  return versionFileRank(path) >= 0
}

/**
 * Coerce a diff-shaped input to text.
 *
 * These functions are exported and take whatever a caller passes. A total
 * function is the right contract here for one blunt reason: a commit must never
 * fail because an analysis helper was handed something unexpected. The cost of
 * being wrong is "the generator had less evidence", not a crashed commit.
 */
function asDiffText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join('\n')
  return ''
}

/** Split a repository-relative path into its segments. */
function segments(path) {
  return path.split('/').filter(part => part !== '')
}

/** The last path segment. */
function basename(path) {
  const parts = segments(path)
  return parts[parts.length - 1] ?? path
}

/** The last path segment without its extension. */
function stem(path) {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Classify one changed path into a Conventional Commits type.
 *
 * Order matters: an explicit test/doc/build path beats an extension rule, and
 * the extension rule beats the generic "product code" answer.
 */
export function typeOfPath(path, status) {
  const parts = segments(path)
  for (const part of parts.slice(0, -1)) {
    for (const [pattern, type] of TYPE_BY_SEGMENT) {
      if (pattern.test(part)) return type
    }
  }
  const name = basename(path)
  if (parts.slice(0, -1).some(part => /^(\.github|\.gitlab|\.circleci)$/i.test(part))) return 'ci'
  if (BUILD_FILE.test(name)) return 'build'
  if (TEST_FILE.test(path)) return 'test'
  if (DOC_FILE.test(name)) return 'docs'
  if (STYLE_FILE.test(name)) return 'style'
  // A dotfile (`.gitignore`, `.npmrc`) has no extension: `lastIndexOf('.')` is 0,
  // so a naive slice would invent the extension "gitignore" and fall through to
  // `feat`. Repository plumbing is housekeeping, never a feature.
  if (name.startsWith('.')) return 'chore'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const byExt = TYPE_BY_EXTENSION.get(ext)
  if (byExt !== undefined) return byExt
  if (status === 'D') return 'refactor'
  return 'feat'
}

/**
 * The most common shared directory among the changed paths.
 *
 * A `src`/`lib`/`app`/`packages` wrapper is transparent: the interesting scope
 * is the module INSIDE it, not the wrapper everyone has. Returns undefined when
 * the changes share no directory.
 */
export function scopeOf(paths) {
  const TRANSPARENT = new Set(['src', 'lib', 'libs', 'app', 'apps', 'packages', 'source', 'sources', 'internal', 'pkg'])
  const counts = new Map()
  for (const path of paths) {
    const parts = segments(path)
    if (parts.length < 2) continue
    let index = 0
    while (index < parts.length - 1 && TRANSPARENT.has(parts[index])) index += 1
    const candidate = parts[index]
    if (candidate === undefined || index >= parts.length - 1) continue
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
  }
  let best
  let bestCount = 0
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && name < best)) {
      best = name
      bestCount = count
    }
  }
  // A scope must be shared: two files, or (for a single-file changeset) the one
  // file's own directory. A directory holding one file out of many is noise.
  if (best === undefined || bestCount < Math.min(2, paths.length)) return undefined
  return best
}

/**
 * Extract identifiers declared by the changed lines of a diff.
 *
 * This is how the generator names a real symbol. Only declaration-shaped
 * added/removed lines are considered, and the first identifier wins so the
 * result is stable across runs.
 *
 * @param {string} unifiedDiff `git diff --unified=0` output
 * @returns {string[]} up to 5 distinct identifiers, in first-seen order
 */
export function declaredSymbols(unifiedDiff) {
  const text = asDiffText(unifiedDiff)
  const found = []
  const patterns = [
    /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\+\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\+\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    /^\+\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\+\s*(?:export\s+)?def\s+([A-Za-z_]\w*)/,
    /^\+\s*(?:export\s+)?func\s+([A-Za-z_]\w*)/,
    /^\+\s*pub(?:lic)?\s+fn\s+([A-Za-z_]\w*)/,
  ]
  for (const line of text.split('\n')) {
    for (const pattern of patterns) {
      const match = pattern.exec(line)
      if (match !== null) {
        const symbol = match[1]
        if (!found.includes(symbol)) found.push(symbol)
        break
      }
    }
    if (found.length >= 5) break
  }
  return found
}

/** Count only removed lines that look like a public declaration. */
export function removedDeclarationCount(unifiedDiff) {
  const text = asDiffText(unifiedDiff)
  let count = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue
    if (/^-\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|func|fn)\b/.test(line)) count += 1
  }
  return count
}

/**
 * Pick the commit type for a whole changeset.
 *
 * `fix` is never inferred: a rule-based generator cannot tell a bug fix from
 * any other edit, and claiming one would put a lie in the history. New files
 * make it a feature; an all-deletion changeset is a refactor; otherwise the
 * type is decided by the dominant file kind.
 *
 * @param {{ status: string, path: string }[]} entries
 * @returns {string} a Conventional Commits type
 */
export function inferType(entries) {
  const kinds = entries.map(entry => typeOfPath(entry.path, entry.status))
  const added = entries.filter(entry => entry.status === 'A')

  // New test/doc/style/build/CI files describe themselves; they must not be
  // promoted to `feat` just because they are new.
  const NEW_FILE_TYPE = { test: 'test', docs: 'docs', style: 'style', build: 'build', ci: 'ci', chore: 'chore' }
  if (added.length > 0) {
    const addKinds = added.map(entry => typeOfPath(entry.path, entry.status))
    const nonFeat = addKinds.filter(kind => kind !== 'feat')
    if (nonFeat.length === addKinds.length) {
      const ranked = rank(nonFeat)
      return NEW_FILE_TYPE[ranked] ?? 'feat'
    }
    return 'feat'
  }

  if (entries.every(entry => entry.status === 'D')) return 'refactor'
  const ranked = rank(kinds)
  return ranked === 'chore' ? 'chore' : ranked
}

/** The most frequent value, with a deterministic tie-break by fixed priority. */
function rank(values) {
  const PRIORITY = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'build', 'ci', 'chore']
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
      continue
    }
    if (count === bestCount && best !== undefined) {
      if (PRIORITY.indexOf(value) !== -1 && (PRIORITY.indexOf(best) === -1 || PRIORITY.indexOf(value) < PRIORITY.indexOf(best))) best = value
    }
  }
  return best ?? 'chore'
}

/**
 * Commit order for the commits of one run.
 *
 * Deterministic on purpose: the same changeset must always produce the same
 * history, so the groups are ordered by Conventional Commits type (product code
 * first, housekeeping last) and then by their `type(scope)` key.
 */
const TYPE_ORDER = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'build', 'ci', 'chore']

/** Position of a type in the canonical commit order; unknown types go last. */
function typeRank(type) {
  const index = TYPE_ORDER.indexOf(type)
  return index === -1 ? TYPE_ORDER.length : index
}

/** Total added/deleted lines across a per-file stat map. */
export function totalsOf(stats) {
  let added = 0
  let deleted = 0
  for (const stat of stats.values()) {
    added += stat.added
    deleted += stat.deleted
  }
  return { added, deleted }
}

/**
 * One Conventional-Commits note per changed file, with its grouping key.
 *
 * @param {object} input
 * @param {{ status: string, path: string, origPath?: string }[]} input.entries
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} input.stats
 * @param {string} input.unifiedDiff the whole sampled diff (may be '')
 * @param {'zh' | 'en'} [input.language]
 * @returns {{ path: string, type: string, scope?: string, key: string, note: string }[]}
 */
export function noteList(input) {
  const { entries, stats, unifiedDiff, language = 'zh' } = input
  const sections = splitDiffSections(unifiedDiff)
  return entries.map((entry) => {
    const stat = stats.get(entry.path) ?? { added: 0, deleted: 0, binary: false }
    const patch = patchForEntry(sections, entry)
    const single = [{ status: entry.status, path: entry.path }]
    const type = inferType(single)
    const scope = scopeOf([entry.path])
    const subject = buildSubject({
      type,
      scope,
      entries: single,
      symbols: declaredSymbols(patch),
      added: stat.added,
      deleted: stat.deleted,
      language,
    })
    const prefix = scopePrefix(type, scope)
    return {
      path: entry.path,
      type,
      scope,
      // The commit this file belongs to: one commit per distinct type(scope).
      key: prefix,
      note: `${prefix}: ${subject}`,
    }
  })
}

/** A full Conventional-Commits line, e.g. `fix(api): …`. */
const CONVENTIONAL_NOTE = /^[a-z][a-z0-9-]*(?:\([^)]*\))?!?: /

/**
 * Index the caller's notes by path, dropping everything unusable.
 *
 * The model writes these, so the function is total: unknown paths (a file that
 * is no longer changed), non-strings and empty notes are ignored rather than
 * failing a commit over a typo in a note.
 *
 * @param {{ path: string }[]} entries
 * @param {unknown} callerNotes
 * @returns {Map<string, string>} path → one-line note
 */
function callerNoteMap(entries, callerNotes) {
  const paths = new Set(entries.map(entry => entry.path))
  const written = new Map()
  if (!Array.isArray(callerNotes)) return written
  for (const item of callerNotes) {
    if (item === null || typeof item !== 'object') continue
    const { path, note } = item
    if (typeof path !== 'string' || typeof note !== 'string' || !paths.has(path)) continue
    const text = note.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    // One body line per file: a caller cannot smuggle a multi-line body into a
    // note, and a runaway note cannot push the real content out of `git log`.
    written.set(path, text.slice(0, 160))
  }
  return written
}

/**
 * Turn a caller-written note into that file's Conventional-Commits body line.
 *
 * A note that already looks Conventional is kept verbatim; a bare subject gets
 * the file's own `type(scope)` prefix so the body stays consistent with the
 * commit it lands in.
 */
function normalizeCallerNote(text, key) {
  return CONVENTIONAL_NOTE.test(text) ? text : `${key}: ${text}`
}

/**
 * Compose one commit message: a subject line, plus a blank line and one typed
 * note per file when the commit carries more than one file.
 *
 * @param {object} input
 * @param {string} input.subjectLine
 * @param {{ path: string, note: string }[]} input.notes
 * @param {number} input.total how many files this commit carries
 * @param {'zh' | 'en'} [input.language]
 * @param {number} [input.maxFiles]
 * @returns {string}
 */
export function composeMessage(input) {
  const {
    subjectLine, notes, total, language = 'zh', maxFiles = 12,
  } = input
  // A single-file commit says everything in its subject.
  if (total <= 1) return subjectLine
  const shown = notes.slice(0, Math.max(0, maxFiles))
  const body = shown.map(({ note, path }) => `- ${note} · ${path}`)
  const hidden = total - shown.length
  if (hidden > 0) {
    body.push(language === 'en' ? `- …and ${hidden} more file${hidden > 1 ? 's' : ''}` : `- …另有 ${hidden} 个文件`)
  }
  // Subject, blank line, body — the shape every git client and `git log`
  // renderer expects, and the one Conventional Commits documents.
  return [subjectLine, '', ...body].join('\n')
}

/**
 * Split a changeset into the commits this plugin will create.
 *
 * ONE COMMIT PER `type(scope)`. The per-file notes that used to travel in the
 * body of a single multi-file commit are the same notes here — they are simply
 * no longer all piled into one commit: every distinct `type(scope)` the changed
 * files fall into becomes its own commit, with its own generated subject, and
 * the files sharing that key carry their per-file notes in that commit's body.
 *
 * A changeset whose files all land in ONE group degenerates to exactly one
 * commit, and `message` is then the single message it always was.
 *
 * @param {object} input
 * @param {{ status: string, path: string, origPath?: string }[]} input.entries normalized changes
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} input.stats
 * @param {string} input.unifiedDiff `git diff --unified=0` text (may be '')
 * @param {string[]} [input.recentSubjects] existing subjects, for tone matching
 * @param {'zh' | 'en'} [input.language]
 * @param {number} [input.maxFiles]
 * @param {{ path: string, note: string }[]} [input.callerNotes] notes written by
 *        the model; they replace the generated note for that path only.
 * @returns {{ message: string, type: string, scope?: string, subject: string,
 *            notes: { path: string, note: string }[],
 *            groups: { key: string, type: string, scope?: string, prefix: string,
 *                      subjectLine: string, message: string, paths: string[],
 *                      entries: object[], notes: object[],
 *                      added: number, deleted: number }[] }}
 */
export function planCommits(input) {
  const {
    entries, stats, unifiedDiff, recentSubjects = [], language = 'zh', maxFiles = 12, callerNotes = [],
  } = input
  const type = inferType(entries)
  const scope = scopeOf(entries.map(entry => entry.path))
  const { added, deleted } = totalsOf(stats)
  const symbols = declaredSymbols(unifiedDiff)
  const subject = buildSubject({ type, scope, entries, symbols, added, deleted, language })
  const subjectLine = `${scopePrefix(type, scope)}: ${subject}`

  const allNotes = noteList({ entries, stats, unifiedDiff, language })
  // Model-written notes win, per path. Grouping (`key`) and the subject stay
  // derived from the file itself — a note can be better prose, but it must not
  // change which commit the file belongs to.
  const written = callerNoteMap(entries, callerNotes)
  if (written.size > 0) {
    for (const note of allNotes) {
      const text = written.get(note.path)
      if (text !== undefined) note.note = normalizeCallerNote(text, note.key)
    }
  }
  const notes = entries.length > 1 ? allNotes.slice(0, Math.max(0, maxFiles)) : []
  const message = composeMessage({
    subjectLine, notes, total: entries.length, language, maxFiles,
  })

  // Group by `type(scope)`, keeping first-seen order inside each group.
  const byKey = new Map()
  entries.forEach((entry, index) => {
    const note = allNotes[index]
    let group = byKey.get(note.key)
    if (group === undefined) {
      group = { key: note.key, type: note.type, scope: note.scope, entries: [], notes: [] }
      byKey.set(note.key, group)
    }
    group.entries.push(entry)
    group.notes.push(note)
  })

  const sections = splitDiffSections(unifiedDiff)
  const groups = [...byKey.values()].map((group) => {
    const patches = group.entries.map(entry => patchForEntry(sections, entry)).filter(text => text !== '')
    const groupStats = new Map(group.entries.map(entry => [
      entry.path,
      stats.get(entry.path) ?? { added: 0, deleted: 0, binary: false },
    ]))
    const totals = totalsOf(groupStats)
    const groupSubject = buildSubject({
      type: group.type,
      scope: group.scope,
      entries: group.entries,
      symbols: declaredSymbols(patches.join('\n')),
      added: totals.added,
      deleted: totals.deleted,
      language,
    })
    const prefix = scopePrefix(group.type, group.scope)
    const paths = []
    for (const entry of group.entries) {
      // A RENAME contributes BOTH paths: naming only the new one commits the
      // addition but leaves the old path's deletion behind, so the repository
      // would still be dirty after a run that promised to commit everything.
      if (entry.origPath !== undefined && !paths.includes(entry.origPath)) paths.push(entry.origPath)
      if (!paths.includes(entry.path)) paths.push(entry.path)
    }
    const line = `${prefix}: ${groupSubject}`
    return {
      ...group,
      prefix,
      subjectLine: line,
      paths,
      added: totals.added,
      deleted: totals.deleted,
      message: composeMessage({
        subjectLine: line, notes: group.notes, total: group.entries.length, language, maxFiles,
      }),
    }
  })
  groups.sort((a, b) => typeRank(a.type) - typeRank(b.type)
    || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)))

  // Tone hint only: never copied into the message, just surfaced to the caller.
  void recentSubjects
  return { message, type, scope, subject, notes, groups }
}

/**
 * Build a Conventional Commits message from observed facts only.
 *
 * The whole-changeset message: what `git log` shows when every changed file
 * falls into one `type(scope)` group, and the preview `prepare` reports.
 *
 * @param {Parameters<typeof planCommits>[0]} input
 * @returns {{ message: string, type: string, scope?: string, subject: string, notes: { path: string, note: string }[] }}
 */
export function buildMessage(input) {
  const { groups, ...single } = planCommits(input)
  void groups
  return single
}

/**
 * Split a `git diff` into one section per changed path.
 *
 * `git diff` emits `diff --git a/<path> b/<path>` headers, so the whole sampled
 * diff can be attributed to files without a second git call per file. Paths are
 * matched by SUFFIX against the paths the caller already knows about (see
 * `patchForEntry`) instead of being parsed out of the header: a filename may
 * itself contain ` b/`, and the known path list is the only unambiguous key.
 *
 * @param {string} diffText
 * @returns {{ header: string, text: string }[]}
 */
export function splitDiffSections(diffText) {
  const sections = []
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) sections.push({ header: line, lines: [line] })
    else if (sections.length > 0) sections[sections.length - 1].lines.push(line)
  }
  return sections.map(section => ({ header: section.header, text: section.lines.join('\n') }))
}

/**
 * The diff section belonging to one changed entry.
 *
 * A rename's header names the OLD path on the left and the new one on the
 * right, so the entry's `origPath` is tried first; everything else matches on
 * the right-hand path alone.
 *
 * @param {{ header: string, text: string }[]} sections
 * @param {{ path: string, origPath?: string }} entry
 * @returns {string} the patch text, or '' when the diff did not cover this file
 */
export function patchForEntry(sections, entry) {
  const right = ` b/${entry.path}`
  const exact = sections.find(section => section.header === `diff --git a/${entry.path}${right}`)
  if (exact !== undefined) return exact.text
  if (entry.origPath !== undefined) {
    const renamed = sections.find(section => section.header.startsWith(`diff --git a/${entry.origPath} `) && section.header.endsWith(right))
    if (renamed !== undefined) return renamed.text
  }
  return sections.find(section => section.header.endsWith(right))?.text ?? ''
}

/** Collapse one diff line to a single short piece of evidence. */
function clipLine(line, limit) {
  const text = line.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Paths whose changed LINES must never be shown to a model.
 *
 * The digest exists to hand a model a line of code; for a dotenv file, a key or
 * a credentials store that line may be the secret itself. The file still gets a
 * generated note — only the digest is withheld.
 */
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|[^/]*(secret|credential|password|passwd|token)[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore))$/i

/**
 * One line of evidence for a changed file: its first removed and first added
 * content line.
 *
 * This is what lets a MODEL write a high-quality per-file note for very few
 * tokens: 60 characters of old and new code say more than the whole diff, and
 * the rest of the diff never has to travel. With `--unified=0` there are no
 * context lines, so both sides belong to the same hunk.
 *
 * @param {{ header: string, text: string }[]} sections `splitDiffSections()` output
 * @param {{ path: string, origPath?: string }} entry
 * @param {number} [limit] characters per side
 * @returns {string | undefined} `-old → +new`, one side only, or undefined
 */
export function digestForEntry(sections, entry, limit = 60) {
  if (SECRET_FILE.test(entry.path)) return undefined
  const patch = patchForEntry(sections, entry)
  if (patch === '') return undefined
  let removed
  let added
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue
    if (removed === undefined && raw.startsWith('-')) {
      const text = clipLine(raw.slice(1), limit)
      if (text !== '') removed = text
      continue
    }
    if (added === undefined && raw.startsWith('+')) {
      const text = clipLine(raw.slice(1), limit)
      if (text !== '') added = text
      continue
    }
    if (removed !== undefined && added !== undefined) break
  }
  if (removed !== undefined && added !== undefined) return `-${removed} → +${added}`
  if (added !== undefined) return `+${added}`
  if (removed !== undefined) return `-${removed}`
  return undefined
}

/**
 * One Conventional-Commits note per changed file.
 *
 * This is what makes a multi-file commit readable: the subject describes the
 * changeset, and every file in it carries its own typed note in the body
 * instead of one shared sentence pretending to cover all of them.
 *
 * The note is derived from THAT file's own status, path, line counts and diff
 * sample, so a documentation file gets `docs:` while a test file gets `test:`.
 *
 * @param {object} input
 * @param {{ status: string, path: string, origPath?: string }[]} input.entries
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} input.stats
 * @param {string} input.unifiedDiff the whole sampled diff (may be '')
 * @param {'zh' | 'en'} [input.language]
 * @param {number} [input.maxFiles] how many files the body may name
 * @returns {{ path: string, note: string }[]}
 */
export function buildPerFileNotes(input) {
  const { entries, stats, unifiedDiff, language = 'zh', maxFiles = 12 } = input
  return noteList({ entries, stats, unifiedDiff, language })
    .slice(0, Math.max(0, maxFiles))
    .map(({ path, note }) => ({ path, note }))
}

/**
 * Compose the subject line itself from the strongest available fact.
 *
 * @param {object} input
 * @param {string} input.type
 * @param {string | undefined} input.scope
 * @param {{ status: string, path: string }[]} input.entries
 * @param {string[]} input.symbols
 * @param {number} input.added
 * @param {number} input.deleted
 * @param {'zh' | 'en'} [input.language]
 * @returns {string}
 */
/**
 * `type(scope)`, with the scope dropped when it only repeats the type.
 *
 * A file under `docs/` infers type `docs` and scope `docs`; emitting
 * `docs(docs): …` reads like a bug, and `docs: …` says the same thing.
 *
 * @param {string} type
 * @param {string | undefined} scope
 * @returns {string}
 */
export function scopePrefix(type, scope) {
  return scope === undefined || scope === type ? type : `${type}(${scope})`
}

export function buildSubject({ type, scope, entries, symbols, added, deleted, language }) {
  // The label names the thing changed: the directory when it adds information,
  // the file itself when the scope would only echo the type.
  const label = scope === undefined || scope === type ? stem(entries[0]?.path ?? 'project') : scope

  if (symbols.length > 0) {
    const named = symbols.slice(0, 2).join('、')
    if (language === 'en') return `update ${named}`
    return type === 'test'
      ? `补充 ${named} 相关测试`
      : `更新 ${named}`
  }

  const files = entries.length
  const removed = entries.filter(entry => entry.status === 'D').length
  const addedFiles = entries.filter(entry => entry.status === 'A').length

  if (addedFiles === files && addedFiles > 0) {
    return language === 'en'
      ? `add ${addedFiles} file${addedFiles > 1 ? 's' : ''}`
      : `新增 ${describeFiles(entries)}`
  }
  if (removed === files && removed > 0) {
    return language === 'en'
      ? `remove ${removed} file${removed > 1 ? 's' : ''}`
      : `移除 ${describeFiles(entries)}`
  }

  const verbs = {
    feat: '实现', fix: '修复', refactor: '重构', perf: '优化', test: '补充测试',
    docs: '更新文档', style: '调整样式', build: '调整构建配置', ci: '调整 CI 配置', chore: '维护',
  }
  const verb = verbs[type] ?? '更新'
  if (language === 'en') return `update ${label} (${files} file${files > 1 ? 's' : ''}, +${added}/-${deleted})`
  return files === 1 ? `${verb} ${label}` : `${verb} ${label} 等 ${files} 个文件`
}

/** A short, human-readable list of the changed file names. */
function describeFiles(entries) {
  const names = entries.slice(0, 2).map(entry => basename(entry.path))
  const suffix = entries.length > 2 ? ` 等 ${entries.length} 个文件` : ''
  return names.join('、') + suffix
}

/**
 * The compact, token-bounded report the model reads.
 *
 * This is the whole point of the plugin: the caller learns what changed, in
 * what shape, and what the deterministic message would be, without ever seeing
 * a diff body. Everything here is derived from one status call, one numstat
 * call, one bounded diff sample, and one log call.
 *
 * @param {object} input
 * @param {string} input.branch
 * @param {{ status: string, path: string }[]} input.entries
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} input.stats
 * @param {string[]} input.recentSubjects
 * @param {{ symbol: string, from?: string, to?: string, file: string } | undefined} input.version
 * @param {boolean} input.breaking
 * @param {{ type: string, scope?: string, subject: string, message: string,
 *           groups?: { subjectLine: string }[] }} input.draft
 * @param {number} input.maxFiles
 * @param {boolean} input.hasUpstream
 * @param {string} [input.unifiedDiff] when present, each shown file carries a
 *        one-line change digest (`-old → +new`) so a MODEL can write its own
 *        per-file note for a few tokens instead of reading the diff.
 * @returns {string} a markdown card, bounded by `maxFiles`
 */
export function renderCard(input) {
  const {
    branch, entries, stats, recentSubjects, version, breaking, draft, maxFiles, hasUpstream, unifiedDiff,
  } = input
  const { added, deleted } = totalsOf(stats)
  const removed = entries.filter(entry => entry.status === 'D').map(entry => entry.path)

  const lines = []
  // A leading, unmissable verdict: the first line is what a person reads when
  // the card renders, so it says what the repository is in and how much of it
  // moved — the "检查到 N 个文件改动" summary, not a process log.
  lines.push(`🔎 **检查到 ${entries.length} 个文件改动（未提交）** · \`${branch}\`${hasUpstream ? '' : '（无 upstream）'} · +${added} / -${deleted}`)

  const counts = new Map()
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
  const label = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪' }
  lines.push('状态：' + [...counts].map(([status, count]) => `${label[status] ?? status} ${count}`).join(' / '))

  // One line per file, each ending in the Conventional-Commits note THAT file
  // would get in the commit body (`draft.notes`); a file whose note the body
  // dropped (the cap) simply shows its stat.
  const notes = new Map((draft.notes ?? []).map(item => [item.path, item.note]))
  const sections = typeof unifiedDiff === 'string' && unifiedDiff !== '' ? splitDiffSections(unifiedDiff) : []
  const shown = entries.slice(0, maxFiles)
  for (const entry of shown) {
    const stat = stats.get(entry.path)
    const delta = stat === undefined ? '' : stat.binary ? ' (binary)' : ` +${stat.added}/-${stat.deleted}`
    const note = notes.get(entry.path)
    const digest = sections.length === 0 ? undefined : digestForEntry(sections, entry)
    lines.push(`  ${label[entry.status] ?? entry.status} ${entry.path}${delta}${note === undefined ? '' : ` → ${note}`}${digest === undefined ? '' : ` ｜ ${digest}`}`)
  }
  if (entries.length > shown.length) lines.push(`  …另有 ${entries.length - shown.length} 个文件`)

  const hints = []
  if (version !== undefined && (version.from !== version.to)) {
    hints.push(`版本号 ${version.from ?? '?'} → ${version.to ?? '?'}（${version.file}）`)
  }
  if (breaking) hints.push('检测到可能的破坏性变更（公共声明被删除）')
  if (entries.length >= 10) hints.push(`文件数 ${entries.length} ≥ 10`)
  if (hints.length > 0) lines.push('标签依据：' + hints.join('；'))

  if (recentSubjects.length > 0) {
    lines.push(`最近提交风格：${recentSubjects.slice(0, 3).map(subject => `"${subject}"`).join(' ')}`)
  }

  // The commit PLAN, not just one title. A changeset whose files fall into
  // several `type(scope)` groups is committed as one commit per group, and this
  // preview card is the only place a person can see that before it happens.
  const groups = Array.isArray(draft?.groups) ? draft.groups : []
  if (groups.length > 1) {
    lines.push(`拟定提交（共 ${groups.length} 次，按 type(scope) 拆分）：`)
    const planned = groups.slice(0, Math.max(1, maxFiles))
    for (const group of planned) lines.push(`  \`${group.subjectLine ?? ''}\``)
    if (groups.length > planned.length) lines.push(`  …另有 ${groups.length - planned.length} 次提交`)
  } else {
    lines.push(`拟定标题：\`${String(draft?.message ?? '').split('\n')[0]}\``)
  }

  if (removed.length > 0) lines.push(`   (删除项 ${removed.length})`)
  lines.push('（仅预览，未提交未推送）')
  return lines.join('\n')
}
