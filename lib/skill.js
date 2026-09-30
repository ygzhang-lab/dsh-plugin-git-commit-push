/**
 * The `git-commit-push` skill this plugin registers at mount time.
 *
 * WHY THE PLUGIN SHIPS ITS OWN SKILL
 * The trigger policy — "commit only when the user asked, never on your own
 * initiative" — has to reach the model through every surface it consults, not
 * just the tool description. A skill file gives the model the full procedure
 * (two-step `prepare` → `apply`, message conventions, boundaries) on demand.
 *
 * Why register it at runtime instead of telling the user to copy SKILL.md into
 * their skills directory: this package is published to npm, so it is installed
 * into `node_modules`, and asking every user to copy a file out of there by
 * hand is exactly the kind of setup step that npm publishing is supposed to
 * remove. `ctx.skills.register(...)` is the documented seam for an in-memory
 * ("embedded") skill and needs no filesystem root.
 *
 * Source of truth is the shipped SKILL.md: the name, the description and the
 * body are parsed from it, so the npm page, the skill catalog and the file can
 * never drift. Precedence is the registry's business: a PROJECT-level skill of
 * the same name outranks this runtime registration, so a user who keeps their
 * own `git-commit-push` skill in the workspace still wins.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the shipped skill file. */
export const SKILL_PATH = join(here, '..', 'SKILL.md')

/** Kebab-case skill name, as the registry's grammar demands. Matches the package name. */
export const SKILL_NAME = 'git-commit-push'

/** `source` label shown in skill listings; the registry adds the `runtime` provider. */
export const SKILL_SOURCE = 'dsh-plugin-git-commit-push'

/** The registry's public skill-name grammar (see `@deepseek-ai/dsh-skill`). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Split a `---`-fenced frontmatter block off a skill file.
 *
 * Deliberately a reader for the flat `key: value` frontmatter this project
 * writes, not a YAML parser: the package ships with no dependencies, and the
 * two fields read here (name, description) are single-line scalars.
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string>, content: string }}
 */
export function parseSkillFile(text) {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (fenced === null) return { fields: {}, content: text.trim() }
  const fields = {}
  for (const line of fenced[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    if (pair === null) continue
    const value = pair[2].trim()
    fields[pair[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
  }
  return { fields, content: text.slice(fenced[0].length).trim() }
}

/**
 * The definition handed to `ctx.skills.register(...)`.
 *
 * Field requirements are the registry's: a kebab-case `name`, a non-empty
 * `description`, an optional `{ modelInvocable, userInvocable }` policy, and a
 * `content` string. `provider` is filled in by the registry (`runtime`), so it
 * is deliberately absent here.
 *
 * @returns {{ name: string, description: string, invocation: { modelInvocable: boolean, userInvocable: boolean }, source: string, content: string } | undefined}
 *   `undefined` when the shipped file is missing or unusable — a skill that
 *   cannot be registered must not take the tool down with it.
 */
export function skillDefinition() {
  let parsed
  try {
    parsed = parseSkillFile(readFileSync(SKILL_PATH, 'utf8'))
  } catch {
    return undefined
  }
  const name = parsed.fields.name ?? SKILL_NAME
  const description = parsed.fields.description ?? ''
  if (!SKILL_NAME_PATTERN.test(name) || description.trim() === '' || parsed.content.trim() === '') return undefined
  return {
    name,
    description,
    // The skill is model-facing procedure; the human-facing surface is the
    // `/git-commit-push` command, so this skill is not offered as a user command.
    invocation: { modelInvocable: true, userInvocable: false },
    source: SKILL_SOURCE,
    content: parsed.content,
  }
}
