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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

console.log('\nreal git: version bumps outside package.json')

const codeVersionFixture = createFixtureRepo('git-commit-code-version-')
codeVersionFixture.write('src/config/index.js', "export default {\n  appVersion: '1.0.0',\n}\n")
codeVersionFixture.commitAll('feat: init settings')
codeVersionFixture.write('src/config/index.js', "export default {\n  appVersion: '1.1.0',\n}\n")

await check('a bump in config/index.js (appVersion) is detected', async () => {
  const result = await survey({ cwd: codeVersionFixture.dir })
  assert.equal(result.ok, true)
  assert.equal(result.version?.file, 'src/config/index.js')
  assert.equal(result.version?.from, '1.0.0')
  assert.equal(result.version?.to, '1.1.0')
})

const envVersionFixture = createFixtureRepo('git-commit-env-version-')
envVersionFixture.write('.env', 'APP_NAME=demo\nVITE_APP_VERSION=1.0.0\n')
envVersionFixture.commitAll('chore: init env')
envVersionFixture.write('.env', 'APP_NAME=demo\nVITE_APP_VERSION=1.2.0\n')

await check('a bump in .env (VITE_APP_VERSION) is detected', async () => {
  const result = await survey({ cwd: envVersionFixture.dir })
  assert.equal(result.ok, true)
  assert.equal(result.version?.file, '.env')
  assert.equal(result.version?.to, '1.2.0')
})

const priorityFixture = createFixtureRepo('git-commit-version-priority-')
priorityFixture.write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n')
priorityFixture.write('src/config/index.js', "export default { appVersion: '2.0.0' }\n")
priorityFixture.commitAll('build: init')
priorityFixture.write('package.json', JSON.stringify({ name: 'demo', version: '1.0.1' }, null, 2) + '\n')
priorityFixture.write('src/config/index.js', "export default { appVersion: '2.0.1' }\n")

await check('a manifest outranks a config module in the same changeset', async () => {
  const result = await survey({ cwd: priorityFixture.dir })
  assert.equal(result.ok, true)
  assert.equal(result.version?.file, 'package.json')
  assert.equal(result.version?.to, '1.0.1')
})

const noiseFixture = createFixtureRepo('git-commit-version-noise-')
noiseFixture.write('vite.config.js', 'export default { server: { version: 2 } }\n')
noiseFixture.commitAll('chore: init vite config')
noiseFixture.write('vite.config.js', 'export default { server: { version: 3 } }\n')

await check('a config file without a dotted version produces no tag evidence', async () => {
  const result = await survey({ cwd: noiseFixture.dir })
  assert.equal(result.ok, true)
  assert.equal(result.version, undefined, 'a bare `version: 3` is a counter, not a release')
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
codeVersionFixture.cleanup()
envVersionFixture.cleanup()
priorityFixture.cleanup()
noiseFixture.cleanup()

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
    assert.match(String(result.card), /本次提交 1 个文件（\+2 \/ -0）/, String(result.card))
    assert.match(String(result.card), /^✅ \*\*Git 提交成功（未推送）\*\*/)
    // The card is a result card: counts and the verdict, never the per-file notes
    // (those live in the commit body) and never raw git output.
    assert.equal(/^\s+- /mu.test(String(result.card)), false, String(result.card))
    // A one-file commit needs no body at all: the subject says everything.
    assert.equal(repo.git(['log', '-1', '--pretty=format:%B']).trim(), 'feat(a): 加两个常量')
  } finally {
    repo.cleanup()
  }
})

await check('a changeset is split into one commit per type(scope) group', async () => {
  // The contract: per-file Conventional notes are not piled into one commit's
  // body — each distinct type(scope) becomes its own commit, in a fixed order.
  const repo = createFixtureRepo('git-commit-plan-')
  try {
    repo.write('src/api/retry.js', 'export function decideRetry(n) { return n < 3 }\n')
    repo.write('src/util/helper.js', 'export function parseHelper(input) { return input }\n')
    repo.write('docs/guide.md', '# guide\n')
    repo.commitAll('chore: base')
    repo.write('src/api/retry.js', 'export function decideRetry(n) { return n < 5 }\n')
    repo.write('src/util/helper.js', 'export function parseHelper(input) { return String(input) }\n')
    repo.write('docs/guide.md', '# guide\n\nRetry twice.\n')
    const before = Number(repo.git(['rev-list', '--count', 'HEAD']).trim())

    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.commits, 3, String(result.card))

    const after = Number(repo.git(['rev-list', '--count', 'HEAD']).trim())
    assert.equal(after, before + 3, 'one commit per type(scope) group')

    // Deterministic order, newest first: feat before docs, feat groups by key.
    const subjects = repo.git(['log', '-n', '3', '--pretty=format:%s']).trim().split('\n')
    assert.deepEqual(subjects, [
      'docs: 更新文档 guide',
      'feat(util): 更新 parseHelper',
      'feat(api): 更新 decideRetry',
    ])

    // A one-file group is a subject-only commit: the per-file notes of a
    // MULTI-file commit are what the body is for, and this commit has one file.
    assert.equal(repo.git(['log', '-n', '1', '--pretty=format:%B']).trim(), 'docs: 更新文档 guide')

    // Nothing may be left behind: the run promised to commit the changeset.
    assert.equal(repo.git(['status', '--porcelain']).trim(), '')

    // The card lists the commits, never the files.
    assert.match(String(result.card), /本次提交 3 个文件（\+\d+ \/ -\d+） · 3 次提交/, String(result.card))
    assert.match(String(result.card), /提交：/)
    assert.match(String(result.card), /`feat\(api\): 更新 decideRetry`/)
    assert.equal(/^\s+- /mu.test(String(result.card)), false, String(result.card))
  } finally {
    repo.cleanup()
  }
})

await check('files that share one type(scope) stay in ONE commit, with one note each', async () => {
  // The other side of the split: grouping must not fragment a coherent change.
  const repo = createFixtureRepo('git-commit-same-scope-')
  try {
    repo.write('src/api/a.js', 'export const a = 1\n')
    repo.write('src/api/b.js', 'export const b = 1\n')
    repo.commitAll('chore: base')
    repo.write('src/api/a.js', 'export const a = 2\n')
    repo.write('src/api/b.js', 'export const b = 2\n')
    const before = Number(repo.git(['rev-list', '--count', 'HEAD']).trim())

    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.commits, 1, String(result.card))
    assert.equal(Number(repo.git(['rev-list', '--count', 'HEAD']).trim()), before + 1)

    const body = repo.git(['log', '-1', '--pretty=format:%B'])
    assert.match(body.split('\n')[0], /^feat\(api\): /, body)
    assert.match(body, /- feat\(api\): [^\n]* · src\/api\/a\.js/, body)
    assert.match(body, /- feat\(api\): [^\n]* · src\/api\/b\.js/, body)
    // A one-group run keeps the original single-commit card shape.
    assert.match(String(result.card), /信息：feat\(api\): /, String(result.card))
  } finally {
    repo.cleanup()
  }
})

await check('a rename and a deletion travel in their own group and leave no residue', async () => {
  // A rename carries TWO paths. Naming only the new one would commit the
  // addition and leave the old path's deletion in the working tree, so a run
  // that reported success would hand back a dirty repository.
  const repo = createFixtureRepo('git-commit-rename-')
  try {
    repo.write('src/api/old.js', 'export function oldThing() { return 1 }\n')
    repo.write('src/util/dropped.js', 'export const dropped = 1\n')
    repo.write('docs/guide.md', '# guide\n')
    repo.commitAll('chore: base')
    repo.git(['mv', 'src/api/old.js', 'src/api/new.js'])
    repo.remove('src/util/dropped.js')
    repo.write('docs/guide.md', '# guide\n\nMore.\n')

    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.commits, 3, String(result.card))
    assert.equal(repo.git(['status', '--porcelain']).trim(), '', 'the run must leave nothing behind')

    const names = repo.git(['log', '-n', '3', '--name-status', '--pretty=format:%s'])
    assert.match(names, /^R\d*\tsrc\/api\/old\.js\tsrc\/api\/new\.js$/mu, names)
    assert.match(names, /^D\tsrc\/util\/dropped\.js$/mu, names)
    const subjects = repo.git(['log', '-n', '3', '--pretty=format:%s']).trim().split('\n')
    assert.deepEqual(subjects.map(line => line.split(':')[0]), ['docs', 'refactor(util)', 'feat(api)'])
  } finally {
    repo.cleanup()
  }
})

await check('a first commit split into groups still works with no HEAD yet', async () => {
  // With an unborn branch there is no parent to diff against and no `HEAD` for
  // the staged numstat, so this is the one path where a partial commit runs
  // against an empty repository.
  const repo = createFixtureRepo('git-commit-unborn-')
  try {
    repo.git(['update-ref', '-d', 'refs/heads/main'])
    repo.write('src/api/a.js', 'export function a() { return 1 }\n')
    repo.write('docs/guide.md', '# guide\n')
    const result = await run({ get: () => undefined }, { action: 'auto', push: false, cwd: repo.dir }, undefined)
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.commits, 2, String(result.card))
    assert.equal(repo.git(['status', '--porcelain']).trim(), '')
    assert.equal(Number(repo.git(['rev-list', '--count', 'HEAD']).trim()), 2)
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

console.log('\nreal git: model-written per-file notes (prepare → apply)')

await check('the prepare card carries a digest, and apply writes the model notes into the body', async () => {
  const repo = createFixtureRepo('git-commit-notes-')
  try {
    repo.write('src/api/a.js', 'export function decideRetry(n) { return n < 3 }\n')
    repo.write('src/api/b.js', 'export const b = 1\n')
    repo.commitAll('chore: base')
    repo.write('src/api/a.js', 'export function decideRetry(n) { return n < 5 }\n')
    repo.write('src/api/b.js', 'export const b = 2\n')

    const prepared = await run({ get: () => undefined }, { action: 'prepare', cwd: repo.dir }, undefined)
    assert.equal(prepared.ok, true, String(prepared.card))
    // The digest is what makes a model-written note cheap: one line of evidence
    // per file instead of the diff.
    assert.match(String(prepared.card), /｜ -export function decideRetry/, String(prepared.card))
    assert.equal(String(prepared.card).includes('@@'), false, String(prepared.card))

    const applied = await run({ get: () => undefined }, {
      action: 'apply',
      message: 'feat(api): 调整重试阈值',
      notes: [
        { path: 'src/api/a.js', note: '重试上限从 3 提高到 5' },
        { path: 'src/api/b.js', note: 'feat(api): 更新 b 的导出值' },
      ],
      push: false,
      cwd: repo.dir,
    }, undefined)
    assert.equal(applied.ok, true, String(applied.card))

    const body = repo.git(['log', '-1', '--pretty=format:%B'])
    assert.match(body, /- feat\(api\): 重试上限从 3 提高到 5 · src\/api\/a\.js/, body)
    assert.match(body, /- feat\(api\): 更新 b 的导出值 · src\/api\/b\.js/, body)
  } finally {
    repo.cleanup()
  }
})

console.log('\nreal git: publishing tags (a tag must actually reach the remote)')

/**
 * A work repo with a real (bare, path-based) remote already tracked.
 *
 * The remote is a directory, so pushing exercises the real code path with no
 * network involved, and `remoteTags()` reads the bare repository directly —
 * a tag that is only local cannot be mistaken for a delivered one.
 */
function createRepoWithRemote(prefix) {
  const repo = createFixtureRepo(prefix)
  const bareRoot = mkdtempSync(join(tmpdir(), `${prefix}remote-`))
  const remote = join(bareRoot, 'origin.git')
  repo.git(['init', '-q', '--bare', remote])
  repo.git(['remote', 'add', 'origin', remote])
  repo.git(['push', '-q', '-u', 'origin', 'main'])
  return {
    repo,
    remote,
    remoteTags: () => repo.git(['--git-dir', remote, 'tag', '--list']).trim().split('\n').filter(Boolean),
    cleanup() {
      repo.cleanup()
      rmSync(bareRoot, { recursive: true, force: true })
    },
  }
}

await check('a tag created by this run is pushed to the remote', async () => {
  const fixture = createRepoWithRemote('git-commit-tag-new-')
  try {
    fixture.repo.write('src/a.js', 'export const a = 1\n')
    const result = await run({ get: () => undefined }, {
      action: 'apply', message: 'feat(a): 新增 a', tag: 'v1.2.3', push: true, cwd: fixture.repo.dir,
    }, undefined)
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.equal(result.pushed, true, String(result.card))
    assert.equal(result.tagCreated, 'v1.2.3', String(result.card))
    assert.equal(result.tagPushed, true, String(result.card))
    assert.match(String(result.card), /标签：v1\.2\.3/)
    assert.deepEqual(fixture.remoteTags(), ['v1.2.3'], 'the remote must carry the tag')
  } finally {
    fixture.cleanup()
  }
})

await check('a custom tag typed in the question is the tag that gets created', async () => {
  // The reported bug: the question's input box was ignored because the plugin
  // only read `selected`. Here a fake answerer stands in for the user typing
  // `release/2024.1` instead of accepting the suggested version tag.
  const fixture = createRepoWithRemote('git-commit-tag-custom-')
  try {
    fixture.repo.write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n')
    fixture.repo.commitAll('build: init package.json')
    fixture.repo.write('package.json', JSON.stringify({ name: 'demo', version: '1.0.1' }, null, 2) + '\n')

    let asked = 0
    const ctx = {
      get: key => key === 'userQuestions'
        ? {
            async askTimed() {
              asked += 1
              return { answers: [{ id: 'git-commit-push-tag', selected: [], custom: 'release/2024.1' }] }
            },
          }
        : undefined,
    }
    const result = await run(ctx, { action: 'auto', push: true, cwd: fixture.repo.dir }, { agent: {}, callId: 'call-1' })

    assert.equal(asked, 1, 'the version bump must trigger the tag question')
    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.tagCreated, 'release/2024.1', String(result.card))
    assert.equal(result.tagPushed, true, String(result.card))
    assert.match(String(result.card), /标签：release\/2024\.1/)
    assert.deepEqual(fixture.remoteTags(), ['release/2024.1'], 'the custom tag must reach the remote')
  } finally {
    fixture.cleanup()
  }
})

await check('a tag that only exists locally is still published', async () => {
  // The reported bug: a tag whose push failed earlier (or was made by hand) stayed
  // local forever, because every later run saw "already exists" and skipped — while
  // reporting "已跳过", which reads like success.
  const fixture = createRepoWithRemote('git-commit-tag-local-')
  try {
    fixture.repo.git(['tag', 'v9.9.9'])
    assert.deepEqual(fixture.remoteTags(), [], 'the fixture must start with no remote tag')
    fixture.repo.write('src/b.js', 'export const b = 2\n')

    const result = await run({ get: () => undefined }, {
      action: 'apply', message: 'feat(b): 新增 b', tag: 'v9.9.9', push: true, cwd: fixture.repo.dir,
    }, undefined)

    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.equal(result.tagCreated, undefined, 'an existing tag must not be recreated')
    assert.equal(result.tagPushed, true, String(result.card))
    assert.match(String(result.card), /标签：v9\.9\.9/)
    assert.deepEqual(fixture.remoteTags(), ['v9.9.9'], 'the pre-existing local tag must reach the remote')
  } finally {
    fixture.cleanup()
  }
})

await check('a tag that cannot be pushed is reported as local-only', async () => {
  // The card must never imply a tag was published when it was not: that is how
  // "the tag only exists on my machine" goes unnoticed.
  const fixture = createRepoWithRemote('git-commit-tag-localonly-')
  try {
    fixture.repo.write('src/c.js', 'export const c = 3\n')
    const result = await run({ get: () => undefined }, {
      action: 'apply', message: 'feat(c): 新增 c', tag: 'v1.0.0', push: false, cwd: fixture.repo.dir,
    }, undefined)
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.equal(result.pushed, false)
    assert.equal(result.tagCreated, 'v1.0.0')
    assert.match(String(result.card), /标签：v1\.0\.0/)
    assert.match(String(result.note ?? ''), /仅本地/)
    assert.deepEqual(fixture.remoteTags(), [], 'nothing may reach the remote')
  } finally {
    fixture.cleanup()
  }
})

await check('with no upstream yet, branch and tag go out in one command', async () => {
  // The other branch of the same code: a brand-new remote has no upstream, so the
  // push names the remote itself and carries both refspecs.
  const repo = createFixtureRepo('git-commit-tag-newbranch-')
  const bareRoot = mkdtempSync(join(tmpdir(), 'git-commit-tag-newbranch-remote-'))
  const remote = join(bareRoot, 'origin.git')
  try {
    repo.git(['init', '-q', '--bare', remote])
    repo.git(['remote', 'add', 'origin', remote])
    repo.write('src/d.js', 'export const d = 4\n')
    const result = await run({ get: () => undefined }, {
      action: 'apply', message: 'feat(d): 新增 d', tag: 'v2.0.0', push: true, cwd: repo.dir,
    }, undefined)
    assert.equal(result.ok, true, `apply failed: ${result.card}`)
    assert.equal(result.pushed, true, String(result.card))
    assert.equal(result.tagPushed, true, String(result.card))
    assert.deepEqual(
      repo.git(['--git-dir', remote, 'tag', '--list']).trim().split('\n').filter(Boolean),
      ['v2.0.0'],
      'the remote must carry the tag',
    )
    assert.match(repo.git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']), /^[0-9a-f]{40}/u)
  } finally {
    repo.cleanup()
    rmSync(bareRoot, { recursive: true, force: true })
  }
})

await check('a multi-commit run tags HEAD, not the first commit of the run', async () => {
  const fixture = createRepoWithRemote('git-commit-tag-multi-')
  try {
    fixture.repo.write('src/api/a.js', 'export const a = 1\n')
    fixture.repo.write('docs/guide.md', '# guide\n')
    fixture.repo.commitAll('chore: base')
    fixture.repo.git(['push', '-q', 'origin', 'main'])
    fixture.repo.write('src/api/a.js', 'export const a = 2\n')
    fixture.repo.write('docs/guide.md', '# guide\n\nMore.\n')

    const result = await run({ get: () => undefined }, {
      action: 'auto', push: true, tag: 'v9.9.9', cwd: fixture.repo.dir,
    }, undefined)

    assert.equal(result.ok, true, `auto failed: ${result.card}`)
    assert.equal(result.commits, 2, String(result.card))
    assert.equal(result.tagPushed, true, String(result.card))
    assert.deepEqual(fixture.remoteTags(), ['v9.9.9'])
    assert.equal(
      fixture.repo.git(['rev-parse', 'v9.9.9^{commit}']).trim(),
      fixture.repo.git(['rev-parse', 'HEAD']).trim(),
      'the tag must point at the last commit of the run',
    )
    assert.equal(fixture.repo.git(['log', '-1', '--pretty=format:%s']).trim(), 'docs: 更新文档 guide')
  } finally {
    fixture.cleanup()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.label}\n${failure.error.stack}\n`)
  process.exitCode = 1
}
