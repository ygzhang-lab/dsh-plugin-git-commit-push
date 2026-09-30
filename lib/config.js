/**
 * Runtime settings.
 *
 * Settings live in a JSON file next to the plugin rather than in the Cordis
 * `Config` schema on purpose: this plugin is loaded from a profile that may not
 * expose its own module resolution to a locally linked package, and a JSON file
 * with defaults is installable, inspectable, and testable without the DSH
 * loader in the loop. Edits are picked up on the next tool call — no restart.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Path of the settings file shipped with the plugin. */
export const CONFIG_PATH = join(here, '..', 'git-commit-push.config.json')

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
 * Read the settings file.
 *
 * A missing or unreadable file is not an error: the shipped defaults are the
 * documented behaviour, and failing a commit because a settings file was
 * deleted would be worse than committing with the defaults.
 *
 * @returns {Promise<typeof DEFAULTS>}
 */
export async function loadSettings() {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8')
    return normalize(JSON.parse(text))
  } catch {
    return { ...DEFAULTS }
  }
}
