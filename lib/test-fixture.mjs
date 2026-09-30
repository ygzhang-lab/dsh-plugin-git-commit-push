/**
 * A throwaway git repository for tests.
 *
 * Everything lives under the OS temp directory and is removed on cleanup, so a
 * test run can exercise real git without touching any repository the user
 * cares about. Git's global and system config are disabled inside the fixture,
 * which makes the commit identity explicit and keeps a user's `commit.gpgsign`,
 * hooks or templates from leaking into a test.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolatedGitEnv } from './git.js'

/** Deterministic identity so a fixture never depends on the machine's config. */
const IDENTITY = { name: 'dsh-plugin-test', email: 'test@example.invalid' }

/**
 * Create a repository with one empty commit in a fresh temp directory.
 *
 * @param {string} [prefix] temp-directory prefix, for readable diagnostics
 * @returns {{ dir: string, git: (args: string[]) => string, write: (path: string, text: string) => void, rename: (from: string, to: string) => void, remove: (path: string) => void, commitAll: (message: string) => void, cleanup: () => void }}
 */
export function createFixtureRepo(prefix = 'git-commit-push-fixture-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  // `isolatedGitEnv()` carries the per-platform `/dev/null` spelling too, which
  // is what keeps this fixture correct on Windows.
  const env = isolatedGitEnv()

  /** Run one git command in the fixture and return stdout. */
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env })

  /** Run git with the fixture's pinned identity (only commits need one). */
  const committed = args => git([
    '-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, ...args,
  ])

  git(['init', '-q', '-b', 'main'])
  committed(['commit', '-q', '--allow-empty', '-m', 'chore: init'])

  return {
    dir,
    git,
    write(path, text) {
      const absolute = join(dir, path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, text)
    },
    rename(from, to) {
      renameSync(join(dir, from), join(dir, to))
    },
    remove(path) {
      rmSync(join(dir, path), { force: true })
    },
    commitAll(message) {
      git(['add', '-A'])
      committed(['commit', '-q', '-m', message])
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
