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

/** Files that carry a version number worth tagging a release for. */
export const VERSION_FILE = /(^|\/)(package\.json|manifest\.json|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|composer\.json|pubspec\.yaml|pom\.xml|__init__\.py)$/

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
 * Build a Conventional Commits message from observed facts only.
 *
 * @param {object} input
 * @param {{ status: string, path: string }[]} input.entries normalized changes
 * @param {Map<string, { added: number, deleted: number, binary: boolean }>} input.stats
 * @param {string} input.unifiedDiff `git diff --unified=0` text (may be '')
 * @param {string[]} [input.recentSubjects] existing subjects, for tone matching
 * @param {'zh' | 'en'} [input.language]
 * @returns {{ message: string, type: string, scope?: string, subject: string }}
 */
export function buildMessage(input) {
  const { entries, stats, unifiedDiff, recentSubjects = [], language = 'zh' } = input
  const type = inferType(entries)
  const scope = scopeOf(entries.map(entry => entry.path))
  const { added, deleted } = totalsOf(stats)
  const symbols = declaredSymbols(unifiedDiff)
  const subject = buildSubject({ type, scope, entries, symbols, added, deleted, language })

  const subjectLine = scope === undefined ? `${type}: ${subject}` : `${type}(${scope}): ${subject}`
  const body = []
  // The body follows the subject's language: a commit whose subject is English
  // and whose bullet list is Chinese reads like an accident to every reviewer.
  if (entries.length > 1) {
    body.push(language === 'en'
      ? `- ${entries.length} files changed (+${added} / -${deleted})`
      : `- 变更文件 ${entries.length} 个（+${added} / -${deleted} 行）`)
    if (symbols.length > 0) body.push(language === 'en' ? `- Touches: ${symbols.join(', ')}` : `- 涉及：${symbols.join(', ')}`)
  }
  if (deleted > 0 && entries.every(entry => entry.status === 'D')) {
    const listed = entries.slice(0, 5).map(entry => entry.path).join(', ')
    body.push(language === 'en'
      ? `- Removed: ${listed}${entries.length > 5 ? ' and more' : ''}`
      : `- 移除文件：${listed}${entries.length > 5 ? ' 等' : ''}`)
  }

  // Tone hint only: never copied into the message, just surfaced to the caller.
  void recentSubjects
  return { message: [subjectLine, ...body].join('\n'), type, scope, subject }
}

/** Compose the subject line itself from the strongest available fact. */
export function buildSubject({ type, scope, entries, symbols, added, deleted, language }) {
  const label = scope ?? stem(entries[0]?.path ?? 'project')

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
 * @param {{ type: string, scope?: string, subject: string, message: string }} input.draft
 * @param {number} input.maxFiles
 * @param {boolean} input.hasUpstream
 * @returns {string} a markdown card, bounded by `maxFiles`
 */
export function renderCard(input) {
  const {
    branch, entries, stats, recentSubjects, version, breaking, draft, maxFiles, hasUpstream,
  } = input
  const { added, deleted } = totalsOf(stats)
  const removed = entries.filter(entry => entry.status === 'D').map(entry => entry.path)

  const lines = []
  lines.push(`**git** · \`${branch}\`${hasUpstream ? '' : '（无 upstream）'} · ${entries.length} 个文件 · +${added} / -${deleted}`)

  const counts = new Map()
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
  const label = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪' }
  lines.push('状态：' + [...counts].map(([status, count]) => `${label[status] ?? status} ${count}`).join(' / '))

  const shown = entries.slice(0, maxFiles)
  for (const entry of shown) {
    const stat = stats.get(entry.path)
    const delta = stat === undefined ? '' : stat.binary ? ' (binary)' : ` +${stat.added}/-${stat.deleted}`
    lines.push(`  ${label[entry.status] ?? entry.status} ${entry.path}${delta}`)
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

  lines.push(`拟定信息：\`${draft.message.split('\n')[0]}\``)

  if (removed.length > 0) lines.push(`   (删除项 ${removed.length})`)
  lines.push('（仅预览，未提交未推送）')
  return lines.join('\n')
}
