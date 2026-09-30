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
 *   1. It edits the parsed object IN PLACE and re-serializes it, so any field
 *      this script does not know about survives untouched (key order included).
 *   2. It writes with NO BOM and a trailing newline. A BOM makes the file
 *      unparseable by `JSON.parse`, which would break the profile's boot.
 *   3. It is idempotent: the plugin's dependency and bundle entries are removed
 *      then re-added exactly once, so running it twice cannot stack duplicates.
 *   4. It verifies its own output by re-parsing the written bytes before
 *      reporting success.
 *
 * Usage:
 *   node lib/profile-edit.mjs --profile-dir <dir> --package <name> --link <dir> [--remove]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Parse `--flag value` pairs without pulling in a dependency. */
function parseArgs(argv) {
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

const args = parseArgs(process.argv.slice(2))
const profileDir = typeof args['profile-dir'] === 'string' ? args['profile-dir'] : undefined
const packageName = typeof args.package === 'string' ? args.package : undefined
const linkTarget = typeof args.link === 'string' ? args.link : undefined
const remove = args.remove === true

if (profileDir === undefined || packageName === undefined || (!remove && linkTarget === undefined)) {
  console.error('usage: node profile-edit.mjs --profile-dir <dir> --package <name> --link <dir> [--remove]')
  process.exit(2)
}

const manifestPath = join(profileDir, 'package.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`cannot read the profile manifest at ${manifestPath}: ${error.message}`)
  process.exit(1)
}

// A BOM survives into the first key of the object under some parsers; drop it.
if (manifest !== null && typeof manifest === 'object' && Object.hasOwn(manifest, '\uFEFF')) {
  delete manifest['\uFEFF']
}

if (manifest.dsh === null || typeof manifest.dsh !== 'object') {
  console.error(`${manifestPath} has no dsh section; refusing to guess where the plugin belongs`)
  process.exit(1)
}
if (manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object') {
  console.error(`${manifestPath} has no dsh.profile section`)
  process.exit(1)
}

// 1. dependencies: drop any previous entry for this package, then re-add once.
const dependencies = { ...(manifest.dependencies ?? {}) }
delete dependencies[packageName]
if (!remove) dependencies[packageName] = `link:${linkTarget}`
manifest.dependencies = dependencies

// 2. bundles: same idempotence, and always a real array (never a bare string,
//    which is what a single-element array can collapse to in some editors).
const currentBundles = manifest.dsh.profile.bundles
const bundles = (Array.isArray(currentBundles) ? currentBundles : currentBundles === undefined ? [] : [currentBundles])
  .filter(entry => typeof entry === 'string' && entry !== packageName)
if (!remove) bundles.push(packageName)
manifest.dsh.profile.bundles = bundles

// 3. Write without a BOM. `JSON.stringify(x, null, 2)` is what makes the diff
//    readable for the user, who will review this file.
const text = `${JSON.stringify(manifest, null, 2)}\n`
writeFileSync(manifestPath, text, { encoding: 'utf8' })

// 4. Prove the bytes we just wrote are valid JSON and carry the intended state.
const verify = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (verify.dependencies?.[packageName] !== undefined && remove) {
  console.error('verification failed: the dependency is still present after removal')
  process.exit(1)
}
if (!remove && verify.dependencies?.[packageName] !== `link:${linkTarget}`) {
  console.error('verification failed: the dependency was not written as expected')
  process.exit(1)
}
if (remove && verify.dsh.profile.bundles.includes(packageName)) {
  console.error('verification failed: the bundle is still listed after removal')
  process.exit(1)
}
if (!remove && !verify.dsh.profile.bundles.includes(packageName)) {
  console.error('verification failed: the bundle was not listed')
  process.exit(1)
}

console.log(`package.json updated (bundles: ${verify.dsh.profile.bundles.join(', ')})`)
