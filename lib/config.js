/**
 * Runtime settings, read from JSON files.
 *
 * TWO SOURCES, IN PRECEDENCE ORDER
 *
 *   1. `$DSH_HOME/git-commit-push.config.json` (default `~/.dsh/…`) — the file a
 *      person owns, and the one that survives reinstalling the package.
 *   2. `<package>/git-commit-push.config.json` — the template shipped in the
 *      tarball, and the file a source checkout is expected to edit.
 *   (Plus the built-in defaults for anything neither of them sets.)
 *
 * THERE IS EXACTLY ONE CONFIGURATION CHANNEL
 * An earlier revision also exported a Cordis `Config` schema so DSH's Settings
 * surface could render a form for this plugin's mounted row, and read the values
 * that form wrote back out of `ctx.fiber.entry.options.config`. The form never
 * appeared on the supported profiles, so the feature was dead weight: the schema
 * (`lib/schema.js`), the row-config layer (`uiOverrides`, `resolveSettings`) and
 * the `@deepseek-ai/schemastery` dependency it needed are all gone.
 *
 * The remaining channel is a JSON file, so the file a person edits has to be
 * FINDABLE: a shipped template buried in `node_modules`, replaced by every
 * reinstall, is not. Mounting the plugin therefore writes the user's own copy at
 * `$DSH_HOME/git-commit-push.config.json` when nothing is there yet (see
 * `ensureUserConfig`), and that copy is the file the precedence above consults
 * first. After that, editing it is the only configuration act, and the next
 * `git_commit_push` call or `/git-commit-push` run picks the change up with no DSH
 * restart.
 *
 * A missing file is not an error at any level. A file that exists but cannot be
 * read as JSON IS reported (see `loadSettingsReport`) instead of being silently
 * ignored — a typo in a config file that quietly does nothing is worse than a
 * visible one.
 *
 * WHY THE FIELD TABLE LIVES HERE
 * `FIELDS` is the single source of truth shared by the loader below, the shipped
 * template, and the tests: a field added to one and forgotten in the other is
 * exactly the kind of drift that makes a user edit a key no code reads.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** The DSH home directory: `$DSH_HOME` when set, else `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/** The user-owned settings file (survives reinstalling the package). */
export function userConfigPath() {
  return join(dshHome(), 'git-commit-push.config.json')
}

/** The template shipped inside the package. */
export const PACKAGE_CONFIG_PATH = join(here, '..', 'git-commit-push.config.json')

/**
 * Back-compat alias. Historic name of the package-local path; new code should
 * use `userConfigPath()` / `configCandidates()`.
 */
export const CONFIG_PATH = PACKAGE_CONFIG_PATH

/** Every settings file consulted, in precedence order. */
export function configCandidates() {
  return [userConfigPath(), PACKAGE_CONFIG_PATH]
}

/** Shipped defaults; every field is overridable in the JSON file. */
export const DEFAULTS = Object.freeze({
  /** Push the branch after a successful commit. */
  autoPush: true,
  /** Stage the whole working tree before committing (the skill's `git add -A`). */
  autoAdd: true,
  /** Trigger the tag question when a version file changed. */
  tagOnVersionChange: true,
  /** Trigger the tag question when at least this many files changed (0 disables). */
  tagOnFileCount: 10,
  /** Trigger the tag question when a public declaration was removed. */
  tagOnBreaking: true,
  /** Prefix for the suggested tag name when the version is known. */
  tagPrefix: 'v',
  /** Ask the user before tagging. When false the suggested tag is created silently. */
  askBeforeTag: true,
  /** How long the in-plugin tag question waits for an answer. */
  askTimeoutMs: 120_000,
  /** `zh` or `en`: the language of a generated subject. */
  defaultLanguage: 'zh',
  /** How many changed paths the `prepare` card lists before collapsing the rest. */
  maxFilesShown: 12,
  /**
   * Commit identity applied per command with `-c user.name/-c user.email`.
   * Empty fields are left alone, so the user's own git identity is used and
   * NEVER written to their configuration.
   */
  pinnedIdentity: Object.freeze({ name: '', email: '' }),
})

/**
 * The settings a person can change, in the order the shipped template lists them.
 *
 * `kind` is what `normalize` accepts for the key; `label` is the one-line
 * description of the setting, kept here so the shipped template, the README
 * table and this table cannot drift apart. Nothing renders it.
 */
export const FIELDS = Object.freeze([
  { key: 'autoPush', kind: 'boolean', label: '提交后自动推送' },
  { key: 'autoAdd', kind: 'boolean', label: '提交前执行 git add -A（把整个工作区的改动加入暂存）' },
  { key: 'tagOnVersionChange', kind: 'boolean', label: '版本文件变化时询问是否打标签' },
  { key: 'tagOnBreaking', kind: 'boolean', label: '检测到公共声明被删除时询问是否打标签（疑似破坏性变更）' },
  { key: 'tagOnFileCount', kind: 'number', label: '改动文件数达到该值时询问打标签（0 = 关闭）', min: 0 },
  { key: 'tagPrefix', kind: 'string', label: '建议标签名的前缀' },
  { key: 'askBeforeTag', kind: 'boolean', label: '打标签前先询问；关闭则直接打建议的标签' },
  { key: 'askTimeoutMs', kind: 'number', label: '标签询问的等待上限（毫秒）', min: 1 },
  { key: 'defaultLanguage', kind: 'string', label: '规则生成提交信息的语言：zh 或 en' },
  { key: 'maxFilesShown', kind: 'number', label: 'prepare 卡片最多列出几个改动文件', min: 1 },
])

/** The nested `pinnedIdentity` fields, kept separate because they are an object. */
export const IDENTITY_FIELDS = Object.freeze([
  { key: 'name', kind: 'string', label: '仅本次提交使用的 user.name（留空则用你的 git 配置）' },
  { key: 'email', kind: 'string', label: '仅本次提交使用的 user.email（留空则用你的 git 配置）' },
])

/** Coerce one loaded value to the shape the plugin expects. */
function normalize(raw) {
  const settings = { ...DEFAULTS }
  if (typeof raw !== 'object' || raw === null) return settings
  if (typeof raw.autoPush === 'boolean') settings.autoPush = raw.autoPush
  if (typeof raw.autoAdd === 'boolean') settings.autoAdd = raw.autoAdd
  if (typeof raw.tagOnVersionChange === 'boolean') settings.tagOnVersionChange = raw.tagOnVersionChange
  if (typeof raw.tagOnBreaking === 'boolean') settings.tagOnBreaking = raw.tagOnBreaking
  if (typeof raw.askBeforeTag === 'boolean') settings.askBeforeTag = raw.askBeforeTag
  if (Number.isFinite(raw.tagOnFileCount) && raw.tagOnFileCount >= 0) settings.tagOnFileCount = Math.floor(raw.tagOnFileCount)
  if (typeof raw.tagPrefix === 'string') settings.tagPrefix = raw.tagPrefix
  if (Number.isFinite(raw.askTimeoutMs) && raw.askTimeoutMs > 0) settings.askTimeoutMs = Math.floor(raw.askTimeoutMs)
  if (raw.defaultLanguage === 'zh' || raw.defaultLanguage === 'en') settings.defaultLanguage = raw.defaultLanguage
  if (Number.isFinite(raw.maxFilesShown) && raw.maxFilesShown > 0) settings.maxFilesShown = Math.floor(raw.maxFilesShown)
  if (typeof raw.pinnedIdentity === 'object' && raw.pinnedIdentity !== null) {
    settings.pinnedIdentity = {
      name: typeof raw.pinnedIdentity.name === 'string' ? raw.pinnedIdentity.name : '',
      email: typeof raw.pinnedIdentity.email === 'string' ? raw.pinnedIdentity.email : '',
    }
  }
  return settings
}

/**
 * Read the settings file that wins, and say which one it was.
 *
 * @returns {Promise<{ settings: typeof DEFAULTS, source?: string, problem?: string }>}
 */
export async function loadSettingsReport() {
  for (const path of configCandidates()) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // Missing is the normal case for the first candidate; anything else
      // (a permission problem, a directory) is worth reporting rather than
      // hiding behind the defaults.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      return { settings: { ...DEFAULTS }, source: path, problem: `无法读取 ${path}：${error?.message ?? String(error)}` }
    }
    try {
      return { settings: normalize(JSON.parse(text)), source: path }
    } catch (error) {
      return {
        settings: { ...DEFAULTS },
        source: path,
        problem: `${path} 不是合法的 JSON 配置（${error?.message ?? String(error)}），已按内置默认值执行`,
      }
    }
  }
  return { settings: { ...DEFAULTS } }
}

/**
 * The effective settings.
 *
 * Never throws: a missing or unreadable file falls back to the documented
 * defaults. Use `loadSettingsReport()` when the caller should tell the user
 * that their file did not take effect.
 *
 * @returns {Promise<typeof DEFAULTS>}
 */
export async function loadSettings() {
  return (await loadSettingsReport()).settings
}

/**
 * The `$comment` the generated USER copy carries (the shipped template explains
 * itself differently: it is the fallback, not the file to edit). Bilingual on
 * purpose — this file is opened by hand, and the plugin's user base and its
 * default message language are Chinese while the package and its docs are not.
 */
export const USER_CONFIG_COMMENT = '你的 dsh-plugin-git-commit-push 配置。安装后由插件自动生成一次；直接编辑保存即可，'
  + '下一次 git_commit_push 调用或 /git-commit-push 生效，无需重启 DSH。本文件优先于包内模板 git-commit-push.config.json；'
  + '删除本文件即回到内置默认值；未写的键同样使用内置默认值，JSON 写坏会在结果卡片里报告。'
  + ' / Your settings for dsh-plugin-git-commit-push. Generated once at first load; edit and save, the next tool call or '
  + '/git-commit-push run picks it up (no DSH restart). It wins over the packaged template; delete it to fall back to the '
  + 'built-in defaults. Omitted keys keep those defaults, and a malformed file is reported in the result card.'

/**
 * Put an editable settings file where the README says it lives, once.
 *
 * WHY THIS EXISTS
 * After the visual form was removed, a JSON file became the ONLY configuration
 * channel — and a channel the user cannot find is not a channel. The template
 * shipped in the package is the wrong file to hand someone: it sits inside
 * `node_modules`, so nobody looks there, and the next reinstall replaces it.
 * Mounting the plugin therefore drops the user's own copy at
 * `$DSH_HOME/git-commit-push.config.json`, which outlives reinstalls and is
 * consulted before the template.
 *
 * RULES
 *   - NEVER overwrites: the write is exclusive (`flag: 'wx'`), so an existing file
 *     — hand-edited, or from an earlier version — wins and this is a no-op. The
 *     check is the write itself, so two racing loads cannot clobber each other.
 *   - NEVER throws: a missing settings file is a valid state (the built-in
 *     defaults apply), so a read-only home, a missing `~/.dsh`, or an unreadable
 *     template degrades to a log line. A commit must never fail because of this.
 *   - Idempotent: it either creates the file or reports that it is already there.
 *
 * @returns {{ status: 'created' | 'exists' | 'failed', path: string, error?: unknown }}
 */
export function ensureUserConfig() {
  const path = userConfigPath()
  let body
  try {
    // The template is the source of the VALUES, so a user copy always starts from
    // the documented defaults; only the explanatory `$comment` differs.
    const template = JSON.parse(readFileSync(PACKAGE_CONFIG_PATH, 'utf8'))
    if (typeof template !== 'object' || template === null) throw new TypeError('the shipped template is not a JSON object')
    template.$comment = USER_CONFIG_COMMENT
    body = `${JSON.stringify(template, null, 2)}\n`
    // A DSH home that cannot be created (a read-only mount, `$DSH_HOME` pointing at
    // a file) is a FAILURE, not "the file is already there" — conflating the two
    // would silently hide a broken home behind a successful-looking no-op.
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    return { status: 'failed', path, error }
  }
  try {
    // `wx` creates and never truncates: the write IS the existence check, so two
    // racing loads cannot clobber a file, hand-edited or from an earlier version.
    writeFileSync(path, body, { encoding: 'utf8', flag: 'wx' })
    return { status: 'created', path }
  } catch (error) {
    if (error?.code === 'EEXIST') return { status: 'exists', path }
    return { status: 'failed', path, error }
  }
}
