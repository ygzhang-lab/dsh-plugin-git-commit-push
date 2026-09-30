/**
 * Runtime settings.
 *
 * THREE SOURCES, IN PRECEDENCE ORDER
 *
 *   1. **The mounted row's `config`** — what DSH's own settings surface shows as
 *      a form (see `lib/schema.js`). This is the layer a person edits in the UI;
 *      it persists into the profile's `cordis.patch.yml` for entry
 *      `git-commit-push` and, for the fields declared volatile, applies live
 *      without a remount.
 *   2. `$DSH_HOME/git-commit-push.config.json` (default `~/.dsh/…`) — the file
 *      a person owns, and the fallback for a `link:`/offline install where the
 *      host's settings surface or its schema library may not be reachable.
 *   3. `<package>/git-commit-push.config.json` — the template shipped in the
 *      tarball, and the file a source checkout is expected to edit.
 *   (Plus the built-in defaults for anything none of them sets.)
 *
 * A missing file is not an error at any level. A file that exists but cannot be
 * read as JSON IS reported (see `loadSettingsReport`) instead of being silently
 * ignored — a typo in a config file that quietly does nothing is worse than a
 * visible one.
 *
 * WHY THE FIELD TABLE LIVES HERE
 * `FIELDS` is the single source of truth shared by the schema builder
 * (`lib/schema.js`), the merge below, and the tests: a field added to one and
 * forgotten in the other is exactly the kind of drift that makes a UI form
 * write values no code reads.
 */
import { readFileSync } from 'node:fs'
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
  /** How many changed paths the card lists before collapsing the rest. */
  maxFilesShown: 12,
  /**
   * Commit identity applied per command with `-c user.name/-c user.email`.
   * Empty fields are left alone, so the user's own git identity is used and
   * NEVER written to their configuration.
   */
  pinnedIdentity: Object.freeze({ name: '', email: '' }),
})

/**
 * The settings a person can change, in the order the form shows them.
 *
 * `kind` matches the schema builder and the coercion in `normalize`; `label` is
 * the description the DSH settings form renders (Chinese, matching this
 * plugin's default message language).
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
  { key: 'maxFilesShown', kind: 'number', label: '卡片最多列出几个改动文件', min: 1 },
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
      // Missing is the normal case for the first two candidates; anything else
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
 * The file layer, read synchronously.
 *
 * Used once per process, as the schema's defaults: a form should open on the
 * values the plugin is actually using, and a schema is built at import time, so
 * it cannot await. A later edit of the file still takes effect on the next tool
 * call — `resolveSettings` prefers the live file value whenever the row config
 * has not overridden that field — but the form's placeholder keeps the value
 * from process start until the next restart.
 *
 * @returns {typeof DEFAULTS}
 */
export function loadFileSettingsSync() {
  for (const path of configCandidates()) {
    try {
      return normalize(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      // A malformed file is reported by `loadSettingsReport`; here the only
      // safe answer is the defaults.
      return { ...DEFAULTS }
    }
  }
  return { ...DEFAULTS }
}

/** Unwrap a volatile field (`schema.volatile()` parses into a `.get()` reference). */
function readLive(value) {
  if (typeof value === 'object' && value !== null && typeof value.get === 'function') return value.get()
  return value
}

/** Deep equality good enough for the scalar/object shapes a settings field holds. */
function sameValue(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (!sameValue(left[key], right[key])) return false
  return true
}

/**
 * The fields the DSH settings surface set, in the shape of a partial settings object.
 *
 * Two signals, strongest first:
 *
 *   1. `ctx.fiber.entry.options.config` — the raw row configuration as written
 *      in the profile patch. Only fields someone actually set are own
 *      properties, so there is no guessing. Reading it is a Cordis internal, so
 *      it is guarded; a host that does not expose it degrades to the next step.
 *   2. A parsed config value that differs from the built-in default must have
 *      come from somewhere above the defaults (the form, or the patch), so it
 *      counts as an override. A value that merely equals our default is
 *      indistinguishable from "not set" and falls through to the live file —
 *      which is the intended precedence anyway.
 *
 * @param {any} ctx plugin context (may be a bare `{ get() {} }` in tests)
 * @param {any} config the config Cordis parsed from the row (may be undefined)
 * @returns {Record<string, unknown>}
 */
export function uiOverrides(ctx, config) {
  const overrides = {}
  const raw = ctx?.fiber?.entry?.options?.config
  const rawIsObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
  for (const field of FIELDS) {
    if (rawIsObject && raw[field.key] !== undefined) overrides[field.key] = raw[field.key]
    else if (!rawIsObject && config !== undefined) {
      const value = readLive(config[field.key])
      if (value !== undefined && !sameValue(value, DEFAULTS[field.key])) overrides[field.key] = value
    }
  }
  const rawIdentity = rawIsObject ? raw.pinnedIdentity : readLive(config?.pinnedIdentity)
  if (typeof rawIdentity === 'object' && rawIdentity !== null) {
    const identity = {}
    for (const field of IDENTITY_FIELDS) {
      const value = readLive(rawIdentity[field.key])
      if (value === undefined) continue
      // Same rule as the scalar fields: with the raw row config in hand, an own
      // property is an explicit choice; without it, only a value that differs
      // from the default can have come from above the defaults.
      if (rawIsObject || !sameValue(value, DEFAULTS.pinnedIdentity[field.key])) identity[field.key] = value
    }
    if (Object.keys(identity).length > 0) overrides.pinnedIdentity = identity
  }
  return overrides
}

/**
 * The settings a call runs with: row config (UI) > user file > template > defaults.
 *
 * @param {{ ui?: Record<string, unknown>, file?: typeof DEFAULTS }} layers
 * @returns {typeof DEFAULTS}
 */
export function resolveSettings({ ui = {}, file } = {}) {
  const base = file ?? { ...DEFAULTS }
  const merged = { ...base }
  for (const field of FIELDS) if (ui[field.key] !== undefined) merged[field.key] = ui[field.key]
  if (ui.pinnedIdentity !== undefined) {
    merged.pinnedIdentity = {
      ...DEFAULTS.pinnedIdentity,
      ...(base.pinnedIdentity ?? {}),
      ...normalizeIdentity(ui.pinnedIdentity),
    }
  }
  return normalize(merged)
}

/** Keep only the identity keys the plugin understands. */
function normalizeIdentity(value) {
  const identity = {}
  if (typeof value !== 'object' || value === null) return identity
  for (const field of IDENTITY_FIELDS) {
    if (typeof value[field.key] === 'string') identity[field.key] = value[field.key]
  }
  return identity
}
