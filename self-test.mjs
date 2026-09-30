/**
 * Self-test for the parts of dsh-plugin-git-commit-push that do not need a live DSH
 * host or a real repository: the deterministic message generator, the change
 * classifier, and the two porcelain parsers.
 *
 * The git parsers are fed byte-exact `-z` output captured from real git, so a
 * parser regression shows up here rather than as a wrong commit.
 *
 * The last two sections check the packaging contract instead of the code: the
 * `dsh.bundle.patch` declaration and the mount row it points at, the display
 * metadata the Plugins page reads, whether the tarball npm would publish
 * actually carries every module the entry point imports, and the settings and
 * skill contracts an npm install depends on.
 *
 * Run it with node (any platform):
 *
 *   node self-test.mjs
 *
 * On Windows with the bundled runtime:
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" self-test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { git, parseStatusZ, tagNameError } from './lib/git.js'
import { buildMessage, inferType, scopeOf, totalsOf, typeOfPath, declaredSymbols, removedDeclarationCount, renderCard } from './lib/analyze.js'
import { normalizeEntries } from './lib/survey.js'
import { loadSettingsReport, DEFAULTS, FIELDS as CONFIG_FIELDS, IDENTITY_FIELDS, resolveSettings, uiOverrides } from './lib/config.js'
import { buildConfigSchema, loadSchemaLibrary, schemaBuildProblem, CONFIG } from './lib/schema.js'
import { parseSkillFile, skillDefinition, SKILL_NAME, SKILL_PATH } from './lib/skill.js'
import { apply, applyCard, inject, COMMAND_NAME, parseCommitCommand, run, TOOL_DEFINITION, toolDefinitionProblems } from './index.js'

let passed = 0
const failures = []

/** Run one named check, collecting rather than throwing on the first failure. */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

function statMap(entries) {
  return new Map(Object.entries(entries))
}

console.log('\nporcelain -z parsing')

check('status: plain modify', () => {
  const parsed = parseStatusZ(' M src/a.js\u0000')
  assert.deepEqual(parsed, [{ xy: ' M', path: 'src/a.js' }])
})

check('status: untracked', () => {
  const parsed = parseStatusZ('?? src/new.js\u0000')
  assert.deepEqual(parsed, [{ xy: '??', path: 'src/new.js' }])
})

check('status: rename consumes the origin field', () => {
  // Real git emits `R  newpath\0oldpath\0` for a staged rename.
  const parsed = parseStatusZ('R  src/new.js\u0000src/old.js\u0000 M src/b.js\u0000')
  assert.deepEqual(parsed, [
    { xy: 'R ', path: 'src/new.js', origPath: 'src/old.js' },
    { xy: ' M', path: 'src/b.js' },
  ])
})

check('status: multiple records and non-ascii paths', () => {
  const parsed = parseStatusZ(' M 中文/文件.js\u0000A  src/x.js\u0000')
  assert.deepEqual(parsed.map(entry => entry.path), ['中文/文件.js', 'src/x.js'])
})

check('normalizeEntries keeps status/staged/unstaged', () => {
  const entries = normalizeEntries(parseStatusZ('?? a.js\u0000M  b.js\u0000 M c.js\u0000D  d.js\u0000'))
  assert.deepEqual(entries.map(entry => entry.status), ['?', 'M', 'M', 'D'])
  assert.equal(entries[1].staged, true)
  assert.equal(entries[2].staged, false)
  assert.equal(entries[2].unstaged, true)
})

console.log('\nchange classification')

check('feat for new source', () => assert.equal(typeOfPath('src/a.ts', 'A'), 'feat'))
check('docs for markdown', () => assert.equal(typeOfPath('README.md', 'M'), 'docs'))
check('docs for a docs directory', () => assert.equal(typeOfPath('docs/guide/x.txt', 'M'), 'docs'))
check('test for a test path', () => assert.equal(typeOfPath('src/a.test.ts', 'M'), 'test'))
check('test for a __tests__ directory', () => assert.equal(typeOfPath('pkg/__tests__/a.ts', 'M'), 'test'))
check('style for css', () => assert.equal(typeOfPath('src/a.css', 'M'), 'style'))
check('build for a lockfile', () => assert.equal(typeOfPath('pnpm-lock.yaml', 'M'), 'build'))
check('build for package.json', () => assert.equal(typeOfPath('package.json', 'M'), 'build'))
check('ci for a workflow', () => assert.equal(typeOfPath('.github/workflows/ci.yml', 'M'), 'ci'))
check('scope skips the src wrapper', () => assert.equal(scopeOf(['src/foo/a.ts', 'src/foo/b.ts']), 'foo'))
check('scope is undefined for scattered root files', () => assert.equal(scopeOf(['a.ts', 'b.ts']), undefined))
check('scope for a single nested file', () => assert.equal(scopeOf(['src/foo/a.ts']), 'foo'))

console.log('\ncommit type inference')

check('new source files are a feature', () => {
  assert.equal(inferType([{ status: 'A', path: 'src/a.ts' }]), 'feat')
})
check('new docs are docs, not feat', () => {
  assert.equal(inferType([{ status: 'A', path: 'docs/x.md' }]), 'docs')
})
check('all deletions are a refactor', () => {
  assert.equal(inferType([{ status: 'D', path: 'src/a.ts' }, { status: 'D', path: 'src/b.ts' }]), 'refactor')
})
check('mixed edits never claim fix', () => {
  const type = inferType([{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'src/b.ts' }])
  assert.notEqual(type, 'fix')
})
check('inferType always returns a string', () => {
  for (const entries of [[], [{ status: 'M', path: 'x.js' }], [{ status: '?', path: '.' }]]) {
    assert.equal(typeof inferType(entries), 'string')
  }
})

console.log('\nmessage generation')

check('subject carries type and scope', () => {
  const built = buildMessage({
    entries: [{ status: 'M', path: 'src/foo/a.ts' }, { status: 'M', path: 'src/foo/b.ts' }],
    stats: statMap({ 'src/foo/a.ts': { added: 3, deleted: 1, binary: false }, 'src/foo/b.ts': { added: 2, deleted: 0, binary: false } }),
    unifiedDiff: '',
  })
  assert.match(built.message.split('\n')[0], /^feat\(foo\): /)
})

check('a declared symbol names the subject', () => {
  const built = buildMessage({
    entries: [{ status: 'M', path: 'src/a.ts' }],
    stats: statMap({ 'src/a.ts': { added: 5, deleted: 0, binary: false } }),
    unifiedDiff: '+export function parseThing(input) {\n',
  })
  assert.match(built.message, /parseThing/)
})

check('buildMessage survives empty and single input', () => {
  assert.doesNotThrow(() => buildMessage({ entries: [], stats: new Map(), unifiedDiff: '' }))
  assert.doesNotThrow(() => buildMessage({ entries: [{ status: 'M', path: 'a.js' }], stats: new Map(), unifiedDiff: '' }))
})

check('english mode produces an english subject', () => {
  const built = buildMessage({
    entries: [{ status: 'M', path: 'src/a.ts' }],
    stats: statMap({ 'src/a.ts': { added: 1, deleted: 1, binary: false } }),
    unifiedDiff: '+export function thing() {}\n',
    language: 'en',
  })
  assert.match(built.message, /update thing/)
})

check('english mode localizes the body too, not just the subject', () => {
  // A commit whose subject is English and whose notes are Chinese reads like an
  // accident; the language setting covers the whole message.
  const entries = [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'src/b.ts' }]
  const stats = statMap({ 'src/a.ts': { added: 2, deleted: 1, binary: false }, 'src/b.ts': { added: 1, deleted: 1, binary: false } })
  const english = buildMessage({ entries, stats, unifiedDiff: '+export function thing() {}\n', language: 'en' })
  assert.equal(/[\u4e00-\u9fa5]/u.test(english.message), false, english.message)
  assert.match(english.message, /- [^\n]*· src\/a\.ts/)
  assert.match(english.message, /- [^\n]*· src\/b\.ts/)

  const chinese = buildMessage({ entries, stats, unifiedDiff: '+export function thing() {}\n' })
  const bodyLines = chinese.message.split('\n').filter(line => line.startsWith('- '))
  assert.equal(bodyLines.length, 2)
  for (const line of bodyLines) assert.match(line, /[\u4e00-\u9fa5]/u, line)
})

console.log('\none Conventional-Commits note per file')

const noteStats = statMap({
  'src/api/retry.ts': { added: 8, deleted: 3, binary: false },
  'docs/guide.md': { added: 4, deleted: 0, binary: false },
  'src/api/retry.test.ts': { added: 12, deleted: 1, binary: false },
})
const noteEntries = [
  { status: 'M', path: 'src/api/retry.ts' },
  { status: 'M', path: 'docs/guide.md' },
  { status: 'A', path: 'src/api/retry.test.ts' },
]
const noteDiff = [
  'diff --git a/src/api/retry.ts b/src/api/retry.ts',
  '@@ -1 +1 @@',
  '-function decideRetry(n) { return n < 3 }',
  '+export function decideRetry(n) { return n < 5 }',
  'diff --git a/docs/guide.md b/docs/guide.md',
  '@@ -1 +1 @@',
  '+Retries now give up after five attempts.',
].join('\n')

check('every file in the body gets its own typed note', () => {
  const { message, notes } = buildMessage({ entries: noteEntries, stats: noteStats, unifiedDiff: noteDiff })
  // Each note is derived from THAT file: the API file is a feat named after the
  // symbol its diff declares, the markdown file is docs, the new test file is
  // a test. One shared sentence could not say all three.
  assert.deepEqual(notes.map(item => item.path), noteEntries.map(entry => entry.path))
  assert.match(message, /- feat\(api\): 更新 decideRetry · src\/api\/retry\.ts/)
  assert.match(message, /- docs: 更新文档 guide · docs\/guide\.md/)
  assert.match(message, /- test\(api\): 新增 retry\.test\.ts · src\/api\/retry\.test\.ts/)
})

check('the body follows the subject after a blank line', () => {
  const { message } = buildMessage({ entries: noteEntries, stats: noteStats, unifiedDiff: noteDiff })
  const [subject, blank, first] = message.split('\n')
  assert.match(subject, /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(|:)/)
  assert.equal(blank, '', 'a body must be separated from the subject by a blank line')
  assert.match(first, /^- /)
})

check('a single file keeps the subject only, with no body at all', () => {
  const { message, notes } = buildMessage({
    entries: [noteEntries[0]],
    stats: noteStats,
    unifiedDiff: noteDiff,
  })
  assert.equal(message.includes('\n'), false)
  assert.deepEqual(notes, [], 'a one-file commit has nothing to itemize')
})

check('a scope that only repeats the type is dropped', () => {
  // `docs(docs): 更新文档 docs` is what the naive composition produces, and it
  // reads like a bug.
  const { message } = buildMessage({ entries: [noteEntries[1]], stats: noteStats, unifiedDiff: noteDiff })
  assert.match(message, /^docs: /)
  assert.equal(message.includes('docs(docs)'), false)
})

check('the body is capped, with an explicit remainder line', () => {
  const { message, notes } = buildMessage({
    entries: noteEntries,
    stats: noteStats,
    unifiedDiff: noteDiff,
    maxFiles: 2,
  })
  assert.equal(notes.length, 2)
  assert.match(message, /- …另有 1 个文件/)
  assert.equal(message.includes('retry.test.ts'), false, 'the capped file must not leak into the body')
})

check('declaredSymbols ignores diff headers and comments', () => {
  const symbols = declaredSymbols('+++ b/src/a.ts\n+// export function fake()\n+export function real()\n')
  assert.deepEqual(symbols, ['real'])
})

check('removedDeclarationCount counts only declarations', () => {
  assert.equal(removedDeclarationCount('-  const x = 1\n+  const x = 2\n'), 1)
  assert.equal(removedDeclarationCount('-  const x = 1\n-  const y = 2\n'), 2)
  assert.equal(removedDeclarationCount('--- a/x\n+++ b/x\n'), 0)
})

check('totalsOf sums both sides', () => {
  const totals = totalsOf(statMap({ a: { added: 2, deleted: 3, binary: false }, b: { added: 1, deleted: 4, binary: false } }))
  assert.deepEqual(totals, { added: 3, deleted: 7 })
})

console.log('\ncard rendering')

check('the preview card leads with an unmissable verdict', () => {
  const card = renderCard({
    branch: 'main',
    entries: noteEntries,
    stats: noteStats,
    recentSubjects: [],
    version: undefined,
    breaking: false,
    draft: buildMessage({ entries: noteEntries, stats: noteStats, unifiedDiff: noteDiff }),
    maxFiles: 12,
    hasUpstream: true,
  })
  assert.match(card.split('\n')[0], /^🔎 \*\*改动预览（未提交）\*\*/)
  // Each file line ends in the note that file would get in the commit body.
  assert.match(card, /src\/api\/retry\.ts.*→ feat\(api\): 更新 decideRetry/)
  assert.match(card, /docs\/guide\.md.*→ docs: 更新文档 guide/)
  assert.match(card, /拟定标题：/)
})

check('card renders without a diff or a version', () => {
  const card = renderCard({
    branch: 'main',
    entries: [{ status: 'M', path: 'src/a.ts' }, { status: 'A', path: 'src/b.ts' }],
    stats: statMap({ 'src/a.ts': { added: 1, deleted: 2, binary: false }, 'src/b.ts': { added: 9, deleted: 0, binary: false } }),
    recentSubjects: ['feat: x'],
    version: undefined,
    breaking: false,
    draft: { message: 'feat(a): x' },
    maxFiles: 1,
    hasUpstream: true,
  })
  assert.match(card, /main/)
  assert.match(card, /另有 1 个文件/)
})

check('card reports tag evidence and deletion count', () => {
  const card = renderCard({
    branch: 'dev',
    entries: [{ status: 'D', path: 'src/old.ts' }],
    stats: new Map(),
    recentSubjects: [],
    version: { file: 'package.json', from: '1.0.0', to: '1.1.0' },
    breaking: true,
    draft: { message: 'refactor: 移除 old' },
    maxFiles: 5,
    hasUpstream: false,
  })
  assert.match(card, /1\.0\.0 → 1\.1\.0/)
  assert.match(card, /破坏性变更/)
  assert.match(card, /无 upstream/)
})

console.log('\nthe commit card states the outcome')

const commitCard = (extra) => applyCard({
  branch: 'main',
  hash: 'a1b2c3d',
  subject: 'feat(api): 更新 retry',
  tagCreated: undefined,
  pushed: false,
  pushedTag: undefined,
  note: undefined,
  fileCount: 2,
  totals: { added: 12, deleted: 4 },
  notes: [
    { path: 'src/api/retry.ts', note: 'feat(api): 更新 decideRetry' },
    { path: 'docs/guide.md', note: 'docs: 更新文档 guide' },
  ],
  autoPush: false,
  maxFiles: 12,
  ...extra,
})

check('a pushed commit says so in the first line', () => {
  const card = commitCard({ pushed: true, autoPush: true })
  assert.match(card.split('\n')[0], /^✅ \*\*Git 提交并推送成功\*\*/)
  assert.match(card, /推送：已推送/)
})

check('a commit that was not pushed says so without looking like a failure', () => {
  const card = commitCard({ pushed: false, autoPush: false })
  assert.match(card.split('\n')[0], /^✅ \*\*Git 提交成功（未推送）\*\*/)
  assert.match(card, /推送：未推送/)
})

check('a failed push is a warning, not a silent success', () => {
  const card = commitCard({ pushed: false, autoPush: true, note: '推送失败（rejected）' })
  assert.match(card.split('\n')[0], /^⚠️ \*\*已提交，但推送失败\*\*/)
  assert.match(card, /推送：失败/)
  assert.match(card, /说明：推送失败/)
})

check('the commit card lists the per-file notes it wrote', () => {
  const card = commitCard({ pushed: true, autoPush: true })
  assert.match(card, /- feat\(api\): 更新 decideRetry · src\/api\/retry\.ts/)
  assert.match(card, /- docs: 更新文档 guide · docs\/guide\.md/)
  assert.match(card, /提交 2 个文件 · \+12 \/ -4/)
})

check('a one-file commit card has no redundant note list', () => {
  const card = commitCard({ notes: [{ path: 'src/api/retry.ts', note: 'feat(api): 更新 decideRetry' }], fileCount: 1 })
  assert.equal(card.includes('  - '), false)
})

console.log('\nargument parsing (/git-commit-push)')

check('bare /git-commit-push is auto', () => {
  assert.deepEqual(parseCommitCommand(''), { action: 'auto' })
})
check('--prepare is preview only', () => {
  assert.equal(parseCommitCommand('--prepare').action, 'prepare')
})
check('a bare message means apply', () => {
  const request = parseCommitCommand('修复登录超时')
  assert.equal(request.action, 'apply')
  assert.equal(request.message, '修复登录超时')
})
check('--no-push is honored', () => {
  assert.equal(parseCommitCommand('--no-push').push, false)
})
check('--tag=NAME is parsed', () => {
  assert.equal(parseCommitCommand('--tag=v1.2.3').tag, 'v1.2.3')
})
check('--en selects english', () => {
  assert.equal(parseCommitCommand('--en').language, 'en')
})
check('a message plus --prepare stays a preview', () => {
  const request = parseCommitCommand('--prepare 想提交的内容')
  assert.equal(request.action, 'prepare')
})

console.log('\nrunner boundaries (no git needed)')

check('the tool definition is registration-ready', () => {
  assert.deepEqual(toolDefinitionProblems(), [])
  assert.equal(TOOL_DEFINITION.parameters.type, 'object')
  assert.equal(Array.isArray(TOOL_DEFINITION.output.schema.required), true)
})

await checkAsync('a non-repository directory is refused, not guessed', async () => {
  const result = await run(
    { get: () => undefined },
    { action: 'prepare', cwd: process.env.SystemRoot ?? '/nonexistent-dir-xyz' },
    undefined,
  )
  assert.equal(result.ok, false)
  assert.match(String(result.card), /未初始化 Git|不是 Git 仓库|找不到 git/)
  assert.equal(typeof result.card, 'string')
  assert.equal(typeof result.pushed, 'boolean')
})

await checkAsync('tagNameError rejects unsafe names without touching a repo', async () => {
  assert.match(String(await tagNameError(process.cwd(), '-badtag')), /start/)
  assert.match(String(await tagNameError(process.cwd(), 'has space')), /whitespace/)
  assert.match(String(await tagNameError(process.cwd(), '')), /empty/)
})

await checkAsync('git() surfaces a clean GitError when git cannot answer', async () => {
  // `rev-parse` inside a path that does not exist must reject with our own
  // GitError (never a raw spawn exception, never a hang, never a bare string).
  await assert.rejects(
    () => git(process.platform === 'win32' ? 'C:\\nonexistent-dsh-test-dir' : '/nonexistent-dsh-test-dir', ['rev-parse'], { timeoutMs: 5_000 }),
    (error) => error instanceof Error && error.name === 'GitError' && typeof error.code === 'string',
  )
})

console.log('\nbundle declaration (what the Plugins page reads)')

/**
 * The package directory, so these checks read the REAL manifest, patch and
 * locale files instead of a copy of what the author believes they say.
 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const bundlePatch = manifest.dsh?.bundle?.patch

/** Strip one layer of YAML quoting. */
function unquote(value) {
  const trimmed = value.trim()
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * The mount rows a bundle patch inserts.
 *
 * Deliberately a hand-written reader for exactly the dialect this patch uses:
 * the plugin ships with NO dependencies (see README, "设计取舍"), so the test
 * cannot reach for a YAML library without making one a runtime dependency. The
 * reader is strict — an unknown line throws, and the check reports it — so a
 * patch that grows a construct it does not understand fails loudly rather than
 * being silently under-read.
 */
function insertRows(text) {
  const rows = []
  let current
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line === '- insert:') { current = undefined; continue }
    const id = /^-\s*id:\s*(.+)$/.exec(line)
    if (id !== null) { current = { id: unquote(id[1]) }; rows.push(current); continue }
    const name = /^name:\s*(.+)$/.exec(line)
    if (name !== null) {
      assert.notEqual(current, undefined, `"${line}" appears before any row id`)
      current.name = unquote(name[1])
      continue
    }
    throw new Error(`unrecognized line in the bundle patch: ${JSON.stringify(raw)}`)
  }
  return rows
}

check('package.json declares a bundle patch', () => {
  // This one field is the difference between "a dependency" and "a bundle":
  // the launcher applies the patch for every profile that selects the package,
  // and the Plugins page refuses every action without it ("not-bundle").
  assert.equal(bundlePatch, './cordis.patch.yml')
})

check('the declared bundle patch exists and is not empty', () => {
  const files = typeof bundlePatch === 'string' ? [bundlePatch] : bundlePatch
  assert.equal(Array.isArray(files) && files.length > 0, true, 'dsh.bundle.patch must be a file or a list of files')
  for (const file of files) {
    assert.equal(typeof file, 'string')
    const text = readFileSync(join(PACKAGE_DIR, file), 'utf8')
    assert.equal(text.trim() === '', false, `${file} is empty`)
  }
})

check('the bundle patch inserts exactly one mount row', () => {
  const rows = insertRows(readFileSync(join(PACKAGE_DIR, bundlePatch), 'utf8'))
  assert.equal(rows.length, 1, 'a second insert of the same id would mount the plugin twice')
})

check('the mount row names this package under a stable id', () => {
  const [row] = insertRows(readFileSync(join(PACKAGE_DIR, bundlePatch), 'utf8'))
  // The id is the Loader entry identity: the Plugins page's per-component
  // switch and any profile override find the row by it, so it must not drift.
  assert.equal(row.id, 'git-commit-push')
  assert.equal(row.name, manifest.name)
})

check('neither installer writes a mount row of its own', () => {
  for (const script of ['setup.ps1', 'setup.sh']) {
    const text = readFileSync(join(PACKAGE_DIR, script), 'utf8')
    assert.equal(
      text.includes('- insert:'),
      false,
      `${script} writes a mount row; the bundle patch owns the only mount`,
    )
    assert.match(text, /legacy mount row/, `${script} must strip the legacy row an earlier revision wrote`)
  }
})

check('the Plugins page can resolve the manifest and locale metadata', () => {
  // readPluginMeta resolves `<specifier>/package.json` and `<specifier>/locale/*`
  // through the package's own `exports` map: without these subpaths both lookups
  // are ERR_PACKAGE_PATH_NOT_EXPORTED and the page falls back to the bare
  // specifier as the title.
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.exports['./locale/*'], './locale/*')
  for (const language of ['en', 'zh']) {
    const file = join(PACKAGE_DIR, 'locale', `${language}.json`)
    assert.equal(existsSync(file), true, `locale/${language}.json is missing`)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    for (const field of ['title', 'description']) {
      const value = parsed.meta?.[field]
      assert.equal(typeof value === 'string' && value.trim() !== '', true, `locale/${language}.json: meta.${field}`)
    }
  }
})

console.log('\npublish readiness (npm)')

/** `files` entries are either exact files or directory prefixes. */
function coveredByFiles(relativePath) {
  return manifest.files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    return clean === relativePath || relativePath.startsWith(`${clean}/`)
  })
}

/** Relative module specifiers a file imports (statically or dynamically). */
function relativeImports(file) {
  const text = readFileSync(file, 'utf8')
  const specifiers = []
  for (const pattern of [
    /\bfrom\s+['"](\.[^'"]*)['"]/gu,
    /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/gu,
    /\bimport\s+['"](\.[^'"]*)['"]/gu,
  ]) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/**
 * Every module reachable from the entry point through relative imports.
 *
 * This is the check that catches the classic npm-publishing accident: a module
 * the entry point needs is missing from the tarball because `files` forgot it,
 * and the package installs cleanly and then fails to load.
 */
function moduleGraph(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of relativeImports(file)) queue.push(resolve(dirname(file), specifier))
  }
  return seen
}

check('the manifest carries what npm and the Plugins page need', () => {
  assert.equal(manifest.private, undefined, 'private: true makes the package unpublishable')
  assert.equal(manifest.name, 'dsh-plugin-git-commit-push')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(typeof manifest.description === 'string' && manifest.description.length > 20, true)
  assert.equal(manifest.license, 'MIT')
  assert.match(String(manifest.author), /<[^@\s]+@[^@\s]+>/, 'author should carry a contact address')
  assert.match(manifest.repository.url, /github\.com\/ygzhang-lab\/dsh-plugin-git-commit-push/)
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(Array.isArray(manifest.keywords) && manifest.keywords.length >= 5, true)
  // npm and pnpm strip publish-only scripts from the packed manifest, and this
  // test ships inside the tarball: an installed copy legitimately lacks it.
  const prepublish = manifest.scripts?.prepublishOnly
  assert.equal(
    prepublish === undefined || /self-test\.mjs/u.test(prepublish),
    true,
    'prepublishOnly must run the self-tests when the packer keeps it',
  )
  assert.match(manifest.scripts.test, /self-test\.mjs/u)
})

check('the dsh manifest follows the documented convention', () => {
  // `dsh.manifestVersion` is the manifest-format identifier (independent of the
  // npm version); `engines.dsh` is where an author declares compatible hosts.
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.equal(typeof manifest.engines.dsh, 'string')
  assert.notEqual(manifest.engines.dsh.trim(), '')
  assert.equal(manifest.engines.git, undefined, 'engines.git is not a field any installer reads')
})

check('no DSH peer is ever installed by the consumer', () => {
  // The peer exists so DSH's own compatibility gate
  // (`evaluatePluginCompatibility`) can compare the host version. The plugin
  // imports nothing from it, so it must be optional: otherwise pnpm would try
  // to fetch a host package into the user's profile.
  const peers = Object.keys(manifest.peerDependencies ?? {})
  assert.equal(peers.length > 0, true, 'the DSH compatibility gate needs a dsh- peer')
  for (const peer of peers) {
    assert.match(peer, /^@deepseek-ai\/dsh(-|$)/, `${peer} is not a DSH package; drop it or make it a real dependency`)
    assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be an optional peer`)
  }
})

check('the schema library is a dependency, never a peer', () => {
  // A profile sets `autoInstallPeers: false`, so a peer would never be
  // installed: the settings form would silently disappear for every user.
  const range = manifest.dependencies?.['@deepseek-ai/schemastery']
  assert.equal(typeof range, 'string', '@deepseek-ai/schemastery must be a dependency')
  assert.match(range, /^\^?\d+\.\d+\.\d+/)
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/schemastery'], undefined)
})

check('the icon satisfies the registry rules', () => {
  const icon = manifest.icon
  assert.equal(typeof icon, 'string')
  assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), false, 'icon must be a relative path')
  assert.match(icon, /\.(svg|png|jpe?g|webp)$/u)
  const file = resolve(PACKAGE_DIR, icon)
  assert.equal(file.startsWith(PACKAGE_DIR), true, 'icon must stay inside the package')
  const stat = statSync(file)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.size <= 256 * 1024, true, 'icon exceeds the 256 KiB limit')
})

check('every file list entry exists', () => {
  for (const entry of manifest.files) {
    assert.equal(existsSync(join(PACKAGE_DIR, entry)), true, `files lists "${entry}", which does not exist`)
  }
})

check('the tarball carries every module the entry point imports', () => {
  for (const file of moduleGraph(join(PACKAGE_DIR, 'index.js'))) {
    const relative = file.slice(PACKAGE_DIR.length + 1).replace(/\\/gu, '/')
    assert.equal(coveredByFiles(relative), true, `files does not publish ${relative}`)
  }
})

check('the tarball carries the files the plugin reads at runtime', () => {
  for (const required of [
    'SKILL.md',
    'cordis.patch.yml',
    'git-commit-push.config.json',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'README.md',
    'README.en.md',
  ]) {
    assert.equal(existsSync(join(PACKAGE_DIR, required)), true, `${required} is missing`)
    assert.equal(coveredByFiles(required), true, `files does not publish ${required}`)
  }
})

check('no author-machine path leaks into the published files', () => {
  // A published README or installer that hard-codes the author's checkout is a
  // broken instruction for everyone else.
  const leaked = []
  for (const entry of manifest.files) {
    const file = join(PACKAGE_DIR, entry)
    if (!statSync(file).isFile() || !/\.(js|mjs|json|md|ps1|sh|ya?ml)$/u.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const needle of ['C:\\Users\\admin', 'D:\\Program Files', 'local-plugins\\dsh-plugin-git-commit-push']) {
      if (text.includes(needle)) leaked.push(`${entry}: ${needle}`)
    }
  }
  assert.deepEqual(leaked, [])
})

console.log('\nsettings files (npm installs live under node_modules)')

const withTemporaryDshHome = async (run) => {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-config-test-'))
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

await checkAsync('a user config next to the DSH home wins over the shipped template', async () => {
  await withTemporaryDshHome(async (home) => {
    const file = join(home, 'git-commit-push.config.json')
    writeFileSync(file, JSON.stringify({ tagPrefix: 'release-', tagOnFileCount: 3 }))
    const report = await loadSettingsReport()
    assert.equal(report.source, file)
    assert.equal(report.problem, undefined)
    assert.equal(report.settings.tagPrefix, 'release-')
    assert.equal(report.settings.tagOnFileCount, 3)
    assert.equal(report.settings.autoPush, DEFAULTS.autoPush, 'omitted keys keep the defaults')
  })
})

await checkAsync('with no user config the shipped template is the source', async () => {
  await withTemporaryDshHome(async () => {
    const report = await loadSettingsReport()
    assert.match(report.source, /git-commit-push\.config\.json$/)
    assert.equal(report.source.startsWith(PACKAGE_DIR), true)
    assert.equal(report.problem, undefined)
  })
})

await checkAsync('a malformed user config is reported, not silently ignored', async () => {
  await withTemporaryDshHome(async (home) => {
    writeFileSync(join(home, 'git-commit-push.config.json'), '{ "autoPush": tru }')
    const report = await loadSettingsReport()
    assert.equal(report.source, join(home, 'git-commit-push.config.json'))
    assert.match(report.problem, /不是合法的 JSON 配置/)
    assert.equal(report.settings.autoPush, DEFAULTS.autoPush)
  })
})

console.log('\nthe embedded skill')

check('the shipped SKILL.md parses into a valid runtime skill', () => {
  const skill = skillDefinition()
  assert.notEqual(skill, undefined, 'SKILL.md is missing or unusable')
  // The registry's own rules (see `validateRuntimeSkill` in @deepseek-ai/dsh-skill).
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.equal(typeof skill.description, 'string')
  assert.equal(skill.description.length > 0, true)
  assert.equal(typeof skill.content, 'string')
  assert.equal(skill.content.length > 0, true)
  assert.equal(skill.content.startsWith('---'), false, 'the frontmatter must not reach the model as instructions')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: false })
  assert.equal(skill.source, manifest.name)
  assert.equal(skill.provider, undefined, 'the registry fills in the runtime provider label')
})

check('the skill name and description come from SKILL.md, not from a copy', () => {
  const { fields } = parseSkillFile(readFileSync(SKILL_PATH, 'utf8'))
  const skill = skillDefinition()
  assert.equal(skill.name, fields.name)
  assert.equal(skill.description, fields.description)
  // The skill is named after the plugin: one name for the tool surface, the
  // command, the skill and the npm package, so nothing has to be looked up
  // under two different names.
  assert.equal(fields.name, 'git-commit-push')
  assert.equal(fields.name, manifest.name.replace(/^dsh-plugin-/u, ''))
})

check('apply registers the tool, the command and the skill', () => {
  const registered = { tools: [], commands: [], skills: [] }
  const services = {
    commands: { register: (command) => registered.commands.push(command) },
    skills: { register: (skill) => registered.skills.push(skill) },
  }
  apply({
    tools: { register: (definition) => registered.tools.push(definition) },
    // `inject` mirrors the Cordis scoped context: the callback runs only when
    // the service is present.
    inject: (names, callback) => {
      for (const service of names) callback({ get: () => services[service] })
    },
    logger: { warn: () => {} },
  })
  assert.deepEqual(registered.tools.map(tool => tool.name), ['git_commit_push'])
  assert.deepEqual(registered.commands.map(command => command.name), ['git-commit-push'])
  assert.deepEqual(registered.skills.map(skill => skill.name), ['git-commit-push'])
})

check('one name covers the command, the skill, the bundle row and the package', () => {
  // The user-visible name of this plugin should not need looking up twice: the
  // slash command, the skill, the Loader row id and the npm package (minus its
  // scope prefix) are the same string.
  const expected = manifest.name.replace(/^dsh-plugin-/u, '')
  assert.equal(expected, 'git-commit-push')
  assert.equal(COMMAND_NAME, expected, 'the slash command name')
  assert.equal(SKILL_NAME, expected, 'the skill name')
  const rows = insertRows(readFileSync(join(PACKAGE_DIR, bundlePatch), 'utf8'))
  assert.equal(rows[0].id, expected, 'the Loader row id')
})

check('the optional services stay optional in the static inject list', () => {
  // Putting skills/commands in `inject` would block the whole plugin — and
  // therefore the tool — on a host that has no such surface.
  assert.deepEqual(inject, ['tools'])
})

check('apply survives a host with no command and no skill surface', () => {
  let registered = 0
  apply({
    tools: { register: () => { registered += 1 } },
    inject: () => {},
    logger: { warn: () => {} },
  })
  assert.equal(registered, 1)
})

console.log('\nthe settings form (Config schema)')

check('the field table matches the built-in defaults', () => {
  // One table drives the schema, the merge and this test: a field added to one
  // and forgotten in the other is how a form ends up writing values no code reads.
  for (const field of CONFIG_FIELDS) {
    assert.equal(Object.hasOwn(DEFAULTS, field.key), true, `${field.key} is missing from DEFAULTS`)
    assert.equal(typeof DEFAULTS[field.key], field.kind, `${field.key} default type`)
    assert.equal(typeof field.label === 'string' && field.label.trim() !== '', true, `${field.key} needs a form label`)
  }
  for (const field of IDENTITY_FIELDS) {
    assert.equal(Object.hasOwn(DEFAULTS.pinnedIdentity, field.key), true, `pinnedIdentity.${field.key}`)
    assert.equal(typeof field.label === 'string' && field.label.trim() !== '', true, `pinnedIdentity.${field.key} needs a label`)
  }
  const listed = new Set(CONFIG_FIELDS.map(field => field.key))
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'pinnedIdentity') continue
    assert.equal(listed.has(key), true, `${key} has a default but no form field`)
  }
})

check('the shipped template names every field', () => {
  const template = JSON.parse(readFileSync(join(PACKAGE_DIR, 'git-commit-push.config.json'), 'utf8'))
  for (const field of CONFIG_FIELDS) assert.equal(Object.hasOwn(template, field.key), true, `template is missing ${field.key}`)
  for (const field of IDENTITY_FIELDS) {
    assert.equal(Object.hasOwn(template.pinnedIdentity ?? {}, field.key), true, `template is missing pinnedIdentity.${field.key}`)
  }
})

check('the schema is published, or degrades without taking the plugin down', () => {
  // @deepseek-ai/schemastery is a real dependency, but a `link:` install can
  // only reach it through the launcher's runtime resolution. Either outcome is
  // supported: a form, or no form with the tool still registered.
  const library = loadSchemaLibrary()
  if (library === undefined) {
    assert.equal(CONFIG, undefined, 'without the library there must be no schema')
    assert.equal(buildConfigSchema(undefined), undefined)
    let registered = 0
    apply({ tools: { register: () => { registered += 1 } }, inject: () => {}, logger: { warn: () => {} } })
    assert.equal(registered, 1, 'the tool must still register')
  } else {
    assert.equal(typeof CONFIG, 'function', `the schema must be built when the library resolves (${schemaBuildProblem() ?? 'no recorded problem'})`)
    assert.equal(typeof CONFIG.dict, 'object')
    for (const field of CONFIG_FIELDS) {
      assert.equal(CONFIG.dict[field.key]?.meta?.volatile, true, `${field.key} must be volatile to apply without a remount`)
    }
  }
})

check('the row config outranks the settings file', () => {
  const file = { ...DEFAULTS, autoPush: true, tagPrefix: 'file-', maxFilesShown: 7 }
  const merged = resolveSettings({ ui: { autoPush: false, tagPrefix: 'ui-' }, file })
  assert.equal(merged.autoPush, false, 'the form wins')
  assert.equal(merged.tagPrefix, 'ui-', 'the form wins for the same field')
  assert.equal(merged.maxFilesShown, 7, 'the file still supplies fields the form did not set')
})

check('pinnedIdentity merges per key, not wholesale', () => {
  const file = { ...DEFAULTS, pinnedIdentity: { name: 'From File', email: 'file@example.com' } }
  const merged = resolveSettings({ ui: { pinnedIdentity: { name: 'From Form' } }, file })
  assert.equal(merged.pinnedIdentity.name, 'From Form')
  assert.equal(merged.pinnedIdentity.email, 'file@example.com', 'an untouched identity key must survive')
})

check('the raw row config is read as the UI layer', () => {
  const ctx = { fiber: { entry: { options: { config: { autoPush: false, tagPrefix: 'form-' } } } } }
  assert.deepEqual(uiOverrides(ctx, undefined), { autoPush: false, tagPrefix: 'form-' })
})

check('without the raw config, only values that differ from the defaults count', () => {
  // A parsed config always carries defaults; treating those as "the user chose
  // them" would make the form silently beat the settings file.
  const parsed = { autoPush: false, autoAdd: DEFAULTS.autoAdd, pinnedIdentity: { name: '', email: 'me@example.com' } }
  assert.deepEqual(uiOverrides({ get: () => undefined }, parsed), {
    autoPush: false,
    pinnedIdentity: { email: 'me@example.com' },
  })
})

check('no context and no config means no UI layer at all', () => {
  assert.deepEqual(uiOverrides({ get: () => undefined }, undefined), {})
  assert.deepEqual(uiOverrides(undefined, undefined), {})
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.label}\n${failure.error.stack}\n`)
  process.exitCode = 1
}
