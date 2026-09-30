/**
 * The Cordis `Config` schema, i.e. the plugin's visual settings form.
 *
 * HOW DSH TURNS THIS INTO A FORM
 * A plugin whose row accepts a `config` mapping exports a schemastery schema as
 * `Config`. DSH's `@deepseek-ai/dsh-settings` service derives a namespace from
 * it (`autoGenerate`), the Settings page renders the fields, and
 * `@deepseek-ai/dsh-config-editor` writes what the person chose into the active
 * profile's `cordis.patch.yml` — for our own entry id, so it lands next to the
 * loader row this bundle inserts, in the same place `ui-theme`'s `preference`
 * lives. A field declared `.volatile()` is written into the running references
 * and announced with `loader/volatile-update`, which is why our values are read
 * through `.get()` on every call instead of being cached at mount: a change in
 * the form takes effect on the next tool call, with no remount and no restart.
 *
 * WHY LOADING THE LIBRARY IS GUARDED
 * The plugin deliberately keeps its runtime imports to itself: with a `link:`
 * install the schema library is reachable only because the launcher installs a
 * runtime resolution computed from the installation and the bundle dependency
 * graphs. If that ever fails, the right outcome is a plugin without a settings
 * form — not a plugin that cannot mount. So the library is loaded through
 * `createRequire` inside a `try`, and every failure (missing library, a schema
 * the library rejects, an unexpected builder result) degrades to `Config ===
 * undefined`, which DSH reads as "this row has no configuration fields".
 *
 * VOLATILE PLACEMENT RULES (enforced by schemastery, easy to get wrong)
 * `validateVolatileSchema` throws for a volatile field under a dict value, an
 * array item, a map key, or a union/lazy branch: volatile fields must sit at a
 * fixed object path and must not be nested inside another volatile field. Every
 * field below is therefore a direct leaf of the root object (or a leaf of the
 * fixed-path `pinnedIdentity` object), never a union or an array item.
 */
import { createRequire } from 'node:module'

import { FIELDS, IDENTITY_FIELDS, loadFileSettingsSync } from './config.js'

/**
 * Load `@deepseek-ai/schemastery` without letting a resolution failure matter.
 *
 * @returns {any | undefined} the schema constructor, or undefined
 */
export function loadSchemaLibrary() {
  try {
    const require = createRequire(import.meta.url)
    const loaded = require('@deepseek-ai/schemastery')
    const Schema = loaded?.default ?? loaded
    return typeof Schema === 'function' ? Schema : undefined
  } catch {
    return undefined
  }
}

/** One leaf field: typed, defaulted from the settings file, described, volatile. */
function leaf(Schema, field, value) {
  const base = field.kind === 'boolean'
    ? Schema.boolean()
    : field.kind === 'number'
      ? Schema.number()
      : Schema.string()
  let node = base.default(value).description(field.label)
  if (typeof field.min === 'number') node = node.min(field.min)
  return node.volatile()
}

/** Why the schema could not be built, for the log and for tests. */
let schemaProblem

/** The reason `CONFIG` is undefined, or undefined when it was built. */
export function schemaBuildProblem() {
  return schemaProblem
}

/**
 * Build the schema.
 *
 * Defaults come from the settings file so the form opens on the values the
 * plugin is actually using; the built-in defaults remain the last resort.
 *
 * @param {any} Schema the schemastery constructor (or undefined)
 * @param {typeof import('./config.js').DEFAULTS} [seed] values to use as defaults
 * @returns {any | undefined} the schema, or undefined when it cannot be built
 */
export function buildConfigSchema(Schema, seed = loadFileSettingsSync()) {
  if (Schema === undefined) {
    schemaProblem = '@deepseek-ai/schemastery could not be resolved from this package'
    return undefined
  }
  try {
    const fields = {}
    for (const field of FIELDS) fields[field.key] = leaf(Schema, field, seed[field.key])
    fields.pinnedIdentity = Schema.object({
      [IDENTITY_FIELDS[0].key]: leaf(Schema, IDENTITY_FIELDS[0], seed.pinnedIdentity?.name ?? ''),
      [IDENTITY_FIELDS[1].key]: leaf(Schema, IDENTITY_FIELDS[1], seed.pinnedIdentity?.email ?? ''),
    }).description('仅本次提交使用的 git 身份（以 -c 传入，不会改写你的 git 配置）')
    const schema = Schema.object(fields)
    schemaProblem = undefined
    return schema
  } catch (error) {
    // A schema the library rejects would otherwise take the whole plugin down at
    // mount; a missing settings form is the lesser failure by far.
    schemaProblem = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
    return undefined
  }
}

/**
 * The schema DSH mounts with this plugin.
 *
 * `undefined` when the schema library cannot be reached — see the note above.
 */
export const CONFIG = buildConfigSchema(loadSchemaLibrary())
