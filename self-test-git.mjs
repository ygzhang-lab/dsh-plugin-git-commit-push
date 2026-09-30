/**
 * Parser and integration tests that need a REAL git repository.
 *
 * Two things are tested here that nothing else can reach:
 *
 *   1. The exact `-z` byte framing of `status` and `--numstat`, including the
 *      rename field order. Getting that order backwards loses the line counts of
 *      every renamed file while still looking correct in code review.
 *   2. That the module graph loads at all. A name imported from a file that does
 *      not export it is an ESM LINK-TIME error, so it only surfaces when
 *      something actually imports the module — which is why survey.js and
 *      index.js are imported explicitly below.
 *
 * Run it with node (any platform):
 *
 *   node self-test-git.mjs
 *
 * On Windows with the bundled runtime:
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" self-test-git.mjs
 */
import assert from 'node:assert/strict'

import { numstat, parseStatusZ, rebaseInProgress, status, tagNameError } from './lib/git.js'
import { survey } from './lib/survey.js'
import { TOOL_DEFINITION, parseCommitCommand, run, toolDefinitionProblems } from './index.js'
import { createFixtureRepo } from './lib/test-fixture.mjs'

let passed = 0
const failures = []

async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

console.log('\nmodule graph + registration-time schema validity')

await check('every plugin module loads (catches wrong-module imports)', () => {
  for (const value of [survey, run, TOOL_DEFINITION, parseCommitCommand, toolDefinitionProblems]) {
    assert.ok(value !== undefined && value !== null)
  }
})

await check('the tool definition satisfies the registry contract', () => {
  const problems = toolDefinitionProblems()
  assert.deepEqual(problems, [], `registration would throw: ${problems.join(' | ')}`)
})

await check('parameters is a real JSON Schema object root', () => {
  const { parameters } = TOOL_DEFINITION
  assert.equal(parameters.type, 'object')
  assert.equal(Array.isArray(parameters.required), true)
  assert.equal(typeof parameters.properties, 'object')
  assert.equal(parameters.additionalProperties, false)
  for (const [name, node] of Object.entries(parameters.properties)) {
    assert.ok(['string', 'number', 'boolean', 'array', 'object'].includes(node.type), `${name} has no usable type`)
    assert.equal(node.required, undefined, `${name} uses the defineTool-only per-property required`)
  }
})

await check('no schema node anywhere uses a boolean required', () => {
  const offenders = []
  const walk = (node, path) => {
    if (typeof node !== 'object' || node === null) return
    if ('required' in node && node.required !== undefined && !Array.isArray(node.required)) {
      offenders.push(`${path}.required = ${JSON.stringify(node.required)}`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`)
    if (node.items !== undefined) walk(node.items, `${path}[]`)
  }
  walk(TOOL_DEFINITION.parameters, 'parameters')
  walk(TOOL_DEFINITION.output.schema, 'output.schema')
  assert.deepEqual(offenders, [])
})

console.log('\nreal git: status --porcelain -z')

const fixture = createFixtureRepo()
fixture.write('src/keep.js', 'export const keep = 1\n')
fixture.write('src/old-name.js', 'export const moved = 1\n')
fixture.write('src/gone.js', 'export const gone = 1\n')
fixture.write('src/中文.js', 'export const zh = 1\n')
fixture.commitAll('feat: base')

// Order matters: edit the file FIRST, then rename it. A rename produces a
// git-detected rename only when the preimage is a TRACKED file; writing after
// the rename would create a new untracked file instead and the test would be
// asserting against the wrong scenario.
fixture.write('src/keep.js', 'export const keep = 2\n')
fixture.rename('src/keep.js', 'src/kept.js')
fixture.git(['mv', 'src/old-name.js', 'src/new-name.js'])
fixture.remove('src/gone.js')
fixture.write('src/brand-new.js', 'export const fresh = 1\n')
fixture.write('src/中文.js', 'export const zh = 2\n')
fixture.write('src/two words.js', 'export const two = 1\n')

await check('the parser agrees with raw git byte-for-byte', async () => {
  // Independent of the parser: ask git for the same information in the
  // machine-readable NON-NUL form and require both to describe the same set of
  // paths. This is what makes the test meaningful rather than a restatement of
  // the implementation.
  //
  // `-c core.quotepath=false` is required here: with git's default, a non-ASCII
  // path is octal-escaped in the non-NUL form (`"src/\344\270\255..."`) while the
  // `-z` form always emits it raw, and the two lists would never match.
  const rawNul = await fixture.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const plain = fixture.git([
    '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all',
  ])
  const plainPaths = plain.split('\n').filter(line => line !== '').map(line => {
    let rest = line.slice(3)
    // `R  old -> new` in the non-NUL form; the CURRENT path is the target.
    const arrow = rest.lastIndexOf(' -> ')
    if (arrow !== -1) rest = rest.slice(arrow + 4)
    // git quotes a path that contains a space, and escapes a literal quote or
    // backslash inside it.
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
      rest = rest.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
    return rest
  }).sort()

  const parsedPaths = parseStatusZ(rawNul).map(entry => entry.path).sort()
  assert.deepEqual(parsedPaths, plainPaths, 'the -z parser disagrees with git\'s own non-NUL listing')

  // Show the raw framing once, so a future mismatch is diagnosable from the log.
  console.log(`        raw -z tokens: ${JSON.stringify(rawNul.split('\u0000'))}`)
})

await check('status parses every entry, including renames and spaced paths', async () => {
  const raw = await status(fixture.dir)
  const byPath = new Map(raw.map(entry => [entry.path, entry]))

  // A STAGED rename (`git mv`) is always detected as a rename, and its origin
  // must be consumed rather than parsed as a second entry.
  assert.equal(byPath.get('src/new-name.js')?.xy, 'R ', 'a staged rename must be seen as a rename')
  assert.equal(byPath.get('src/new-name.js')?.origPath, 'src/old-name.js', 'a staged rename must carry its origin')
  assert.equal(byPath.get('src/old-name.js'), undefined, 'the rename preimage must not also appear as an entry')

  assert.equal(byPath.get('src/gone.js')?.xy, ' D')
  assert.equal(byPath.get('src/brand-new.js')?.xy, '??')
  assert.equal(byPath.get('src/two words.js')?.xy, '??', 'a path with a space must survive -z intact')
  assert.equal(byPath.get('src/中文.js')?.xy, ' M', 'non-ascii paths must survive -z intact')

  // The bug this guards: an unconsumed origin field becomes a phantom entry.
  const phantom = raw.filter(entry => entry.path.endsWith('.js') && !entry.path.startsWith('src/'))
  assert.deepEqual(phantom, [], `phantom entries parsed from rename origins: ${JSON.stringify(phantom)}`)
})

await check('a WORKTREE-side rename is detected when git detects it', async () => {
  // git's rename detection here is a similarity heuristic, NOT a guarantee: a
  // file that is both renamed and heavily edited is reported as ` D` + `??`
  // instead. So this asserts a property that must hold EITHER WAY — an entry
  // for the origin may not survive as a phantom — and additionally that when
  // git DOES report a worktree rename, the parser consumes its origin field.
  const raw = await status(fixture.dir)
  const kept = raw.find(entry => entry.path === 'src/kept.js')
  assert.ok(kept !== undefined, 'the renamed path must appear in the status listing')
  if (kept.xy[1] === 'R' || kept.xy[0] === 'R') {
    assert.equal(kept.origPath, 'src/keep.js', 'a worktree rename must carry its origin')
  } else {
    assert.equal(kept.xy, '??', `unexpected status ${kept.xy} for a heuristic rename`)
  }
  const phantom = raw.filter(entry => entry.path.endsWith('.js') && !entry.path.startsWith('src/'))
  assert.deepEqual(phantom, [])
})

await check('parseStatusZ handles the raw bytes git actually emits', () => {
  const staged = 'R  src/new.js\u0000src/old.js\u0000 M src/zh.js\u0000'
  assert.deepEqual(parseStatusZ(staged), [
    { xy: 'R ', path: 'src/new.js', origPath: 'src/old.js' },
    { xy: ' M', path: 'src/zh.js' },
  ])
  const worktreeRename = ' R src/kept.js\u0000src/keep.js\u0000'
  assert.deepEqual(parseStatusZ(worktreeRename), [
    { xy: ' R', path: 'src/kept.js', origPath: 'src/keep.js' },
  ])
})

console.log('\nreal git: diff --numstat -z rename keying')

await check('a renamed file is keyed by its CURRENT path', async () => {
  // Dedicated fixture: a rename with a small edit, STAGED so git must report it
  // as a rename (`R` in the index). This is the scenario that exercises the
  // `add TAB del TAB NUL preimage NUL postimage NUL` framing.
  const renameFixture = createFixtureRepo('git-commit-rename-')
  try {
    renameFixture.write('src/alpha.js', 'export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n')
    renameFixture.commitAll('feat: alpha')
    renameFixture.rename('src/alpha.js', 'src/renamed-alpha.js')
    renameFixture.write('src/renamed-alpha.js', 'export const alpha = 1\nexport const beta = 99\nexport const gamma = 3\n')
    renameFixture.git(['add', '-A'])

    const entries = await status(renameFixture.dir)
    const renamed = entries.find(entry => entry.path === 'src/renamed-alpha.js')
    assert.equal(renamed?.xy[0], 'R', `fixture must produce a staged rename, got ${JSON.stringify(entries)}`)

    const stats = await numstat(renameFixture.dir, true)
    // The whole point: the map is keyed by the CURRENT path, because that is the
    // path the status entries and the card use.
    assert.ok(
      stats.get('src/renamed-alpha.js') !== undefined,
      `expected key "src/renamed-alpha.js"; got ${[...stats.keys()].join(', ')}`,
    )
    assert.equal(stats.get('src/alpha.js'), undefined, 'the map must not be keyed by the rename preimage')

    const counts = stats.get('src/renamed-alpha.js')
    assert.equal(counts.added >= 1 && counts.deleted >= 1, true, `expected +n/-n, got ${JSON.stringify(counts)}`)
  } finally {
    renameFixture.cleanup()
  }
})

await check('a modified tracked file is counted, and untracked files appear in the status', async () => {
  const stats = await numstat(fixture.dir, false)
  const modified = stats.get('src/中文.js')
  assert.ok(modified !== undefined)
  assert.equal(modified.added >= 1 && modified.deleted >= 1, true, `expected +n/-n, got ${JSON.stringify(modified)}`)

  const raw = await status(fixture.dir)
  assert.ok(raw.some(entry => entry.path === 'src/brand-new.js' && entry.xy === '??'))
})

console.log('\nreal git: version-bump detection (package.json style)')

const versionFixture = createFixtureRepo('git-commit-version-')
versionFixture.write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n')
versionFixture.commitAll('build: init package.json')
versionFixture.write('package.json', JSON.stringify({ name: 'demo', version: '2.0.5' }, null, 2) + '\n')

await check('an unstaged "version": JSON bump is detected', async () => {
  const result = await survey({ cwd: versionFixture.dir })
  assert.equal(result.ok, true, 'survey should succeed')
  assert.ok(result.version !== undefined, 'a package.json version bump must be detected')
  assert.equal(result.version.to, '2.0.5')
  assert.equal(result.version.from, '1.0.0')
})

await check('a bump that is already staged is detected', async () => {
  versionFixture.git(['add', 'package.json'])
  const result = await survey({ cwd: versionFixture.dir })
  assert.equal(result.ok, true)
  assert.equal(result.version?.to, '2.0.5')
})

console.log('\nreal git: survey over a mixed changeset')

await check('survey reports entries, stats, draft and tag evidence', async () => {
  const result = await survey({ cwd: fixture.dir })
  assert.equal(result.ok, true, 'survey should succeed')
  assert.equal(result.branch, 'main')
  assert.ok(result.entries.length > 0)
  assert.equal(typeof result.draft.message, 'string')
  assert.match(result.draft.message.split('\n')[0], /^[a-z]+(\([^)]+\))?: /, 'draft must be Conventional Commits')
  assert.equal(Array.isArray(result.recentSubjects), true)
  assert.equal(result.recentSubjects[0], 'feat: base')
  assert.equal(result.hasUpstream, false, 'a fixture has no upstream')
})

await check('a clean repository reports "nothing to commit"', async () => {
  const clean = createFixtureRepo('git-commit-clean-')
  try {
    const result = await survey({ cwd: clean.dir })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'clean')
  } finally {
    clean.cleanup()
  }
})

await check('a non-repository directory is reported, not guessed', async () => {
  const result = await survey({ cwd: process.env.SystemRoot ?? '/nonexistent-dir-xyz' })
  assert.equal(result.ok, false)
  assert.ok(result.notRepo === true || result.reason === 'git-unavailable')
})

console.log('\nreal git: tag names and rebase probing')

await check('tagNameError accepts a good name and rejects unsafe ones', async () => {
  assert.equal(await tagNameError(fixture.dir, 'v1.2.3'), undefined)
  assert.equal(await tagNameError(fixture.dir, 'release/1.2.3'), undefined)
  assert.match(String(await tagNameError(fixture.dir, '-badtag')), /start/)
  assert.match(String(await tagNameError(fixture.dir, 'has space')), /whitespace/)
  assert.match(String(await tagNameError(fixture.dir, '')), /empty/)
  assert.match(String(await tagNameError(fixture.dir, 'bad..name')), /not a valid/)
})

await check('rebaseInProgress is false in a quiet repository', async () => {
  assert.equal(await rebaseInProgress(fixture.dir), false)
})

fixture.cleanup()
versionFixture.cleanup()

console.log('\nrunner boundaries')

await check('run(prepare) returns a schema-shaped value on a fixture repo', async () => {
  const repo = createFixtureRepo('git-commit-run-')
  try {
    repo.write('src/a.js', 'export const a = 1\n')
    const result = await run({ get: () => undefined }, { action: 'prepare', cwd: repo.dir }, undefined)
    assert.equal(result.ok, true)
    assert.equal(result.action, 'prepare')
    assert.equal(typeof result.card, 'string')
    assert.equal(typeof result.pushed, 'boolean')
    assert.ok(Array.isArray(result.changes))
    assert.deepEqual(Object.keys(result.changes[0]).sort(), ['path', 'status'])
  } finally {
    repo.cleanup()
  }
})

await check('run(apply) commits, and --no-push keeps it local', async () => {
  const repo = createFixtureRepo('git-commit-apply-')
  try {
    repo.write('src/a.js', 'export const a = 1\n')
    const result = await run(
      { get: () => undefined },
      { action: 'apply', message: 'feat(a): 新增 a 模块', push: false, cwd: repo.dir },
      undefined,
    )
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.match(String(result.hash), /^[0-9a-f]{7,}$/)
    assert.equal(result.pushed, false)
    assert.equal(repo.git(['log', '-1', '--pretty=format:%s']).trim(), 'feat(a): 新增 a 模块')
  } finally {
    repo.cleanup()
  }
})

await check('run(auto) uses the rule-generated message', async () => {
  const repo = createFixtureRepo('git-commit-auto-')
  try {
    repo.write('docs/guide.md', '# guide\n')
    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    const subject = repo.git(['log', '-1', '--pretty=format:%s']).trim()
    assert.match(subject, /^docs/, `expected a docs-typed subject, got: ${subject}`)
  } finally {
    repo.cleanup()
  }
})

await check('the commit card reports the real line counts', async () => {
  // The staged numstat used to race `git add`, so a commit that changed lines
  // reported `+0 / -0` — a wrong number exactly where a person looks for
  // confirmation that their work landed.
  const repo = createFixtureRepo('git-commit-totals-')
  try {
    repo.write('src/a.js', 'export const a = 1\n')
    repo.git(['add', '-A'])
    repo.git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init'])
    repo.write('src/a.js', 'export const a = 1\nexport const b = 2\nexport const c = 3\n')

    const result = await run({ get: () => undefined }, { action: 'apply', message: 'feat(a): 加两个常量', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.match(String(result.card), /提交 1 个文件 · \+2 \/ -0/, String(result.card))
    assert.match(String(result.card), /^✅ \*\*Git 提交成功（未推送）\*\*/)
  } finally {
    repo.cleanup()
  }
})

await check('a multi-file commit lands as ONE commit with one note per file', async () => {
  const repo = createFixtureRepo('git-commit-notes-')
  try {
    repo.write('src/api/retry.js', 'export function decideRetry(n) { return n < 3 }\n')
    repo.write('docs/guide.md', '# guide\n')
    repo.git(['add', '-A'])
    repo.git(['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init'])
    // One modified file that declares something, one new documentation file.
    repo.write('src/api/retry.js', 'export function decideRetry(n) { return n < 5 }\n')
    repo.write('docs/retry.md', '# retry\n')
    const before = Number(repo.git(['rev-list', '--count', 'HEAD']).trim())

    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)

    const after = Number(repo.git(['rev-list', '--count', 'HEAD']).trim())
    assert.equal(after, before + 1, 'the notes must not become separate commits')
    const body = repo.git(['log', '-1', '--pretty=format:%B'])
    const lines = body.split('\n')
    assert.match(lines[0], /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)/, body)
    assert.equal(lines[1], '', 'subject and body are separated by a blank line')
    assert.match(body, /- [^\n]*decideRetry[^\n]* · src\/api\/retry\.js/, body)
    assert.match(body, /- [^\n]* · docs\/retry\.md/, body)
    assert.equal(lines.filter(line => line.startsWith('- ')).length, 2, body)
  } finally {
    repo.cleanup()
  }
})

await check('a caller subject keeps its own body when it wrote one', async () => {
  const repo = createFixtureRepo('git-commit-verbatim-')
  try {
    repo.write('src/a.js', 'export const a = 1\n')
    repo.write('src/b.js', 'export const b = 1\n')
    const result = await run(
      { get: () => undefined },
      { action: 'apply', message: 'feat(a): 两个文件一起改\n\nBREAKING CHANGE: 接口改了', push: false, cwd: repo.dir },
      undefined,
    )
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    const body = repo.git(['log', '-1', '--pretty=format:%B'])
    assert.match(body, /^feat\(a\): 两个文件一起改\n\nBREAKING CHANGE: 接口改了\n?$/, body)
    assert.equal(body.includes(' · src/'), false, 'an explicit body must not be decorated with generated notes')
  } finally {
    repo.cleanup()
  }
})

await check('a caller subject with no body gets the per-file notes appended', async () => {
  const repo = createFixtureRepo('git-commit-subject-only-')
  try {
    repo.write('src/a.js', 'export const a = 1\n')
    repo.write('src/b.js', 'export const b = 1\n')
    const result = await run(
      { get: () => undefined },
      { action: 'apply', message: 'feat(a): 两个文件', push: false, cwd: repo.dir },
      undefined,
    )
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    const body = repo.git(['log', '-1', '--pretty=format:%B'])
    assert.match(body, /^feat\(a\): 两个文件\n\n- /, body)
    assert.match(body, /· src\/a\.js/)
    assert.match(body, /· src\/b\.js/)
  } finally {
    repo.cleanup()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.label}\n${failure.error.stack}\n`)
  process.exitCode = 1
}
