/**
 * Profile manifest edit shared by the Windows and macOS/Linux installers.
 *
 * Editing a user's profile `package.json` is the one step that must not go
 * wrong, and doing it in a shell is where portability bugs live (`/dev/null` vs
 * `NUL`, `sed -i` flag differences, JSON escaping). The installers therefore
 * delegate this single step here, so both platforms run the SAME reviewed code
 * and a fix lands on both at once.
 *
 * Guarantees, in order of importance:
 *
 *   1. It edits the parsed object and re-serializes it, so any field this script
 *      does not know about survives untouched — KEY ORDER INCLUDED, for the rows
 *      it touches as well: an existing dependency key and an existing bundle row
 *      keep the position the user put them in. (An earlier revision deleted and
 *      re-appended both, so every re-run of an installer shuffled the profile's
 *      bundle order for no reason.)
 *   2. It writes with NO BOM and a trailing newline. A BOM makes the file
 *      unparseable by `JSON.parse`, which would break the profile's boot.
 *   3. It is idempotent, and a second run is a true NO-OP: the rows are applied
 *      without stacking duplicates, and when the serialized result equals what is
 *      already on disk the file is not written at all (no mtime churn for
 *      whatever is watching the profile).
 *   4. It verifies its own output by re-parsing the written bytes before
 *      reporting success.
 *
 * Usage:
 *   node lib/profile-edit.mjs --profile-dir <dir> --package <name> --link <dir> [--remove]
 *
 * The CLI prints one line and always exits 0 on success; a failure exits 1 with
 * the reason on stderr, so an installer can rely on the exit code alone.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Parse `--flag value` pairs without pulling in a dependency. */
export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

/**
 * The exact bytes an installer writes: 2-space indent (the user reviews this
 * file), no BOM, one trailing newline.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Apply the plugin's dependency and bundle rows to a profile manifest.
 *
 * The object is MUTATED (the caller owns it; nothing else holds a reference), so
 * a caller can re-serialize it and diff the bytes.
 *
 * Both rows are positional: an entry that is already there is updated IN PLACE,
 * never removed and re-appended. Duplicates of this package collapse to the first
 * occurrence — Loader `insert` is append-only and does not de-duplicate, so two
 * rows with the same id would mount the plugin twice.
 *
 * @param {object} manifest parsed profile package.json (mutated)
 * @param {{ packageName: string, linkTarget?: string, remove?: boolean }} options
 * @returns {{ bundles: string[], dependency: string | undefined }}
 */
export function editManifest(manifest, options) {
  const { packageName, linkTarget, remove = false } = options

  // 1. dependencies: keep an existing key where it is (`dependencies[key] = …`
  //    does not move it) and only append when the package is new to the profile.
  const dependencies = { ...(manifest.dependencies ?? {}) }
  if (remove) {
    delete dependencies[packageName]
  } else {
    dependencies[packageName] = `link:${linkTarget}`
  }
  manifest.dependencies = dependencies

  // 2. bundles: always a real array (never a bare string, which is what a
  //    single-element array can collapse to in some editors), with this package
  //    appearing exactly once, where it already was.
  const current = manifest.dsh?.profile?.bundles
  const list = (Array.isArray(current) ? current : current === undefined ? [] : [current])
    .filter(entry => typeof entry === 'string')
  const seen = list.indexOf(packageName)
  const bundles = remove
    ? list.filter(entry => entry !== packageName)
    : (seen === -1
      ? [...list, packageName]
      : list.filter((entry, index) => entry !== packageName || index === seen))
  manifest.dsh.profile.bundles = bundles

  return { bundles, dependency: dependencies[packageName] }
}

/**
 * Validate one parsed manifest before it is written, so a refusal never leaves a
 * half-edited profile behind.
 *
 * @returns {string | undefined} a reason, or undefined when the manifest is usable
 */
export function manifestProblem(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return 'the profile manifest is not a JSON object'
  }
  if (manifest.dsh === null || typeof manifest.dsh !== 'object') {
    return 'it has no dsh section; refusing to guess where the plugin belongs'
  }
  if (manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object') {
    return 'it has no dsh.profile section'
  }
  return undefined
}

/**
 * The whole install/uninstall edit, as the CLI runs it.
 *
 * @param {string} profileDir
 * @param {{ packageName: string, linkTarget?: string, remove?: boolean }} options
 * @returns {{ status: 'created' | 'updated' | 'unchanged', bundles: string[] }}
 */
export function editProfileManifest(profileDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the profile manifest at ${manifestPath}: ${error.message}`)
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cannot read the profile manifest at ${manifestPath}: ${error.message}`)
  }

  // A BOM survives into the first key of the object under some parsers; drop it.
  if (manifest !== null && typeof manifest === 'object' && Object.hasOwn(manifest, '\uFEFF')) {
    delete manifest['\uFEFF']
  }

  const problem = manifestProblem(manifest)
  if (problem !== undefined) throw new Error(`${manifestPath}: ${problem}`)

  const { bundles, dependency } = editManifest(manifest, options)

  const text = serializeManifest(manifest)
  // A second run must not touch the file: identical bytes mean there is nothing
  // to write, and rewriting them would be a gratuitous change to a file the user
  // owns (and to its mtime).
  const status = raw === text ? 'unchanged' : (raw.trim() === '' ? 'created' : 'updated')
  if (status !== 'unchanged') writeFileSync(manifestPath, text, { encoding: 'utf8' })

  // Prove the bytes on disk are valid JSON and carry the intended state.
  const verify = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (options.remove === true) {
    if (verify.dependencies?.[options.packageName] !== undefined) {
      throw new Error('verification failed: the dependency is still present after removal')
    }
  } else if (verify.dependencies?.[options.packageName] !== `link:${options.linkTarget}`) {
    throw new Error('verification failed: the dependency was not written as expected')
  }
  if (options.remove === true && verify.dsh.profile.bundles.includes(options.packageName)) {
    throw new Error('verification failed: the bundle is still listed after removal')
  }
  if (options.remove !== true && !verify.dsh.profile.bundles.includes(options.packageName)) {
    throw new Error('verification failed: the bundle was not listed')
  }
  if (options.remove !== true && dependency !== `link:${options.linkTarget}`) {
    throw new Error('verification failed: the dependency row is inconsistent with the bundles row')
  }

  return { status, bundles }
}

/* c8 ignore start -- CLI wiring; the exported helpers above are what the tests drive */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  const profileDir = typeof args['profile-dir'] === 'string' ? args['profile-dir'] : undefined
  const packageName = typeof args.package === 'string' ? args.package : undefined
  const linkTarget = typeof args.link === 'string' ? args.link : undefined
  const remove = args.remove === true

  if (profileDir === undefined || packageName === undefined || (!remove && linkTarget === undefined)) {
    console.error('usage: node profile-edit.mjs --profile-dir <dir> --package <name> --link <dir> [--remove]')
    process.exit(2)
  }
  try {
    const { status, bundles } = editProfileManifest(profileDir, { packageName, linkTarget, remove })
    const suffix = status === 'unchanged' ? 'already up to date' : status
    console.log(`package.json ${suffix} (bundles: ${bundles.join(', ')})`)
  } catch (error) {
    console.error(`profile-edit: ${error.message}`)
    process.exit(1)
  }
}
/* c8 ignore stop */
