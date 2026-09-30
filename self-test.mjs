/**
 * Self-test for the parts of dsh-plugin-git-commit-push that do not need a live DSH
 * host or a real repository: the deterministic message generator, the change
 * classifier, and the two porcelain parsers.
 *
 * The git parsers are fed byte-exact `-z` output captured from real git, so a
 * parser regression shows up here rather than as a wrong commit.
 *
 * The last section checks the packaging contract instead of the code: the
 * `dsh.bundle.patch` declaration, the mount row it points at, the display
 * metadata the Plugins page reads, and the fact that neither installer writes a
 * mount row of its own (two inserts of one id mount the plugin twice).
 *
 * Run it with node (any platform):
 *
 *   node self-test.mjs
 *
 * On Windows with the bundled runtime:
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" self-test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { git, parseStatusZ, tagNameError } from './lib/git.js'
import { buildMessage, inferType, scopeOf, totalsOf, typeOfPath, declaredSymbols, removedDeclarationCount, renderCard } from './lib/analyze.js'
import { normalizeEntries } from './lib/survey.js'
import { parseCommitCommand, run, TOOL_DEFINITION, toolDefinitionProblems } from './index.js'

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

console.log('\nargument parsing (/commit-push)')

check('bare /commit-push is auto', () => {
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
  assert.equal(bundlePatch, 'cordis.patch.yml')
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

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.label}\n${failure.error.stack}\n`)
  process.exitCode = 1
}
