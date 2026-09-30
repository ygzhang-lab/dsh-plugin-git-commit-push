# dsh-plugin-git-commit-push

English | [中文](README.md)

A one-call "commit + push" plugin for DSH (DeepSeek Harness): the whole workflow a model would otherwise
run through ten-odd shell calls and several screens of raw git output becomes **1–2 tool calls and one
compact card** — and the slash-command path costs **zero model tokens**. It is the tool-ified replacement
for the early `.agents/skills/git-commit` skill; the skill that ships with the package is named
`git-commit-push`.

```
changes → git_commit_push(prepare)          ← one card, no diff
        → you write the Conventional Commits message
        → git_commit_push(apply, message)   → commit / tag question / push, one result card
```

Installing gives you three surfaces:

| Surface | Name | Used by |
|---|---|---|
| Tool | `git_commit_push` (`prepare` / `apply` / `auto`) | the model |
| Slash command | `/commit-push` | you, **with no model round-trip at all** |
| Skill | `git-commit-push` | the model, loading the full procedure on demand |

- Platforms: **Windows and macOS / Linux** (see "Platforms")
- Requirements: DSH `>=0.2.0-rc.1 <0.3.0`, Node `>=20`, git `>=2.36`

## Install

### A. Plugins page (recommended)

DSH → **Settings → Plugins** → type the package name into the install field:

```
dsh-plugin-git-commit-push
```

Then **restart DSH**. The same page can **enable / disable / uninstall** it — which is exactly why this
package declares `dsh.bundle.patch` and makes itself a DSH *bundle*. Without that declaration the page
answers every request with **"这个包没有声明组合包，不能作为插件管理"** (host code `not-bundle`).

### B. Command line

```sh
dsh plugin --profile <profile> add dsh-plugin-git-commit-push     # install
dsh plugin --profile <profile> remove dsh-plugin-git-commit-push  # uninstall
```

`<profile>` is your profile name (`web`, `headless`, a custom one). Both directions edit the profile's
`package.json` (dependency + `dsh.profile.bundles`) and **need a DSH restart**.

### C. From a checkout (development / offline)

Clone the repository and use the installer to wire the checkout into a profile as a `link:` dependency:

```powershell
# Windows (default profile: desktop)
powershell -ExecutionPolicy Bypass -File .\setup.ps1
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Profile web
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
```

```bash
# macOS / Linux
sh setup.sh              # default profile: desktop
sh setup.sh web          # a specific profile
sh setup.sh web --uninstall
```

The scripts do two things (idempotent, with backups): add the checkout as a `link:` dependency and add the
package name to `dsh.profile.bundles`, then run `pnpm install` inside the profile. **The mount row is not
written by the scripts** — it comes from this package's own bundle patch (see "The DSH bundle contract").
They also **remove** the mount row an older revision wrote into the profile's `cordis.patch.yml`, because
Loader `insert` is append-only and the same id mounted twice would register the plugin twice.

> Do not mix the three ways: a package should be mounted exactly once per profile.

### After installing

Once DSH is restarted:

- the model can call `git_commit_push`, and you can type `/commit-push`;
- Settings → Plugins lists this package (title "Git 提交与推送", with an icon) and can enable/disable/uninstall it;
- the model's skill catalog contains `git-commit-push`.

## Trigger policy (read this first)

**Only two situations may use it; it never fires on its own:**

1. **the user typed the `/commit-push` slash command** — the command runs it, no model involved;
2. **the user explicitly asked** to commit and/or push ("commit", "push", "提交", "推送").

**Finishing an edit, completing a task, an almost-over session, or a user saying "save it" are NOT
triggers.** Editing files is not a request to commit them. When in doubt, ask instead of committing.

The rule is stated in three model-visible places: the `git_commit_push` tool description (the first thing
a model reads when choosing a tool), [SKILL.md](<./SKILL.md>) (registered as an embedded skill at mount
time), and the command description. The plugin cannot enforce it inside `execute` — by then the decision
has already been made.

## Is "0 tokens for commit + push" accurate?

**Partly — it needs qualification.** The honest split is by path:

| Path | Model tokens | Why |
|---|---|---|
| **1. `/commit-push` slash command** | **0 (really)** | No model request is made at all. Command discovery, execution and UI output cost no model tokens, and the result is rendered in the UI only — it never enters the transcript. This is the **only** truly 0-token path. |
| **2. `git_commit_push(auto)` tool call** | a few | The model has to emit the call (arguments + thinking). The plugin writes the message itself, so there is **no** second round-trip; the card is ~200 tokens. One round trip. |
| **3. `prepare` + `apply` (default)** | ~2 round trips | Only the `prepare` card (~200 tokens) and the `apply` `message` argument enter the context — **no diff is read**. |

So: "the slash command costs 0 tokens" is accurate; "the tool costs 0 tokens" is **not** — the model still
pays for each call. What the plugin saves is **comparative**: reading raw git output (thousands of tokens →
~200) and several round trips.

One **fixed cost** must also be stated: while the plugin is installed and the tool is visible to the model,
its schema (a ~1.5 KB description plus parameters) enters **every** request — roughly **600 tokens**, paid
even when you never commit. If you only want `/commit-push` and never let the model call the tool, moving
the tool out of the model-visible surface (or `deferLoading` it) removes that cost.

## Usage

```
git_commit_push({ action: "prepare" })                        # survey only, no writes
git_commit_push({ action: "apply", message: "feat(x): …" })   # commit + push
git_commit_push({ action: "auto" })                           # commit with the rule-generated message
git_commit_push({ action: "apply", message: "…", tag: "v1.2.3" })
git_commit_push({ action: "prepare", cwd: "/path/to/repo" })   # session cwd is not the repository
```

`/commit-push` variants (**0 tokens, no model involved**):
`/commit-push`, `/commit-push --prepare`, `/commit-push --no-push`, `/commit-push --en`, `/commit-push --tag=v1.2.3`, `/commit-push fix login timeout`.

### What the card looks like

```
**git** · `main` · 3 files · +48 / -12
status: 1 added / 2 modified
  added    src/foo/bar.ts +40/-0
  modified src/foo/baz.ts +8/-10
  deleted  src/old.ts
tag evidence: version 1.2.3 → 1.2.4 (package.json)
recent style: "feat(ui): add theme switch" "fix(api): correct retry decision"
draft: `feat(foo): update bar`
(preview only — nothing committed, nothing pushed)
```

And after a commit:

```
**git commit** · `main` · `a1b2c3d`
message: feat(foo): add bar component
3 files committed · +48 / -12
tag: v1.2.4
push: pushed (tag included)
```

(Card text is localized: `defaultLanguage: "zh"` or `"en"`.)

## Settings

**The right place to change settings** is a user-owned file in the DSH home — an npm install keeps the
package itself inside `node_modules`, where an edit is lost at the next install or update:

```
<DSH_HOME>/git-commit-push.config.json          # default ~/.dsh/git-commit-push.config.json
```

Precedence: **user file > shipped template (`git-commit-push.config.json`) > built-in defaults**.
A missing file is not an error (the defaults are the documented behaviour). A file that exists but is not
valid JSON is **reported** — the result card gains a "配置未生效: …" line rather than silently doing
nothing. Changes apply to the next tool call; no DSH restart. Omitted keys keep their defaults.

| Key | Default | Meaning |
|---|---|---|
| `autoPush` | `true` | push after a successful commit |
| `autoAdd` | `true` | `git add -A` before committing |
| `tagOnVersionChange` | `true` | ask about a tag when a version file changed |
| `tagOnBreaking` | `true` | ask when a public declaration was removed |
| `tagOnFileCount` | `10` | ask when ≥ N files changed (`0` disables) |
| `tagPrefix` | `"v"` | suggested tag prefix |
| `askBeforeTag` | `true` | `false` tags silently (the only "no question" switch) |
| `askTimeoutMs` | `120000` | how long the tag question waits |
| `defaultLanguage` | `"zh"` | language of the generated message (`zh`/`en`) |
| `maxFilesShown` | `12` | how many paths the card lists |
| `pinnedIdentity.name/email` | empty | applied per commit with `-c user.name/-c user.email`; your git config is never written |

Environment: `DSH_HOME` is the DSH home (default `~/.dsh`, Windows `%USERPROFILE%\.dsh`); it also decides
where the user settings file lives.

## The `git-commit-push` skill

[SKILL.md](<./SKILL.md>) is registered as an **embedded skill** (`ctx.skills.register(...)`) when the
plugin mounts, so there is nothing to copy into a skills directory after an npm install. The skill name
matches the package name (minus the `dsh-plugin-` prefix): the tool, the command, the skill and the npm
package share one name instead of two.

- To **override** it, keep a project-level skill of the same name (`.agents/skills/git-commit-push/SKILL.md`).
  The registry ranks **project > runtime registration**, so your copy wins.
- A host without a skill registry still works: the skill and the `/commit-push` command are **optional
  capabilities** (awaited through a scoped `ctx.inject`), and losing either never affects the
  `git_commit_push` tool.
- **Coming from an early revision**: if you manually installed the old SKILL.md into
  `~/.agents/skills/git-commit/`, that is a user-level skill under a *different* name and will appear next
  to the bundled `git-commit-push`. The package now owns that content, so deleting that directory is
  recommended (or keep it and put your own rules there — different names, so neither shadows the other).

## Safety boundary

**Never**: modify `.gitignore`, write git config (including `user.name`/`user.email`), `push --force`,
`reset --hard`, `git clean`, `checkout -- <path>`, or `commit --no-verify`.
[lib/git.js](<./lib/git.js>) is the only place that talks to git and its command set is fixed — adding a
destructive verb means changing that file first.

**Handled automatically**: `push -u origin <branch>` when there is no upstream; a rejected push
(the remote moved) retries once after `pull --rebase`; on a rebase conflict it aborts **only the rebase it
started itself** (probing `rebase-merge`/`rebase-apply` first, so your own rebase progress is never
discarded) and reports honestly; an existing or invalid tag name is skipped with an explanation.

**Tagging is conservative**: a tag is created only with your explicit consent (or `askBeforeTag: false`).
An explicitly passed `tag` argument is treated as an instruction and skips the question. No answerer
available, you are not present (a delegated call), or the wait timed out — all mean **do not tag**, and the
card tells you how to add it later with the `tag` argument.

**It does not guess**: when the session directory is not a repository it reports the candidate repositories
for you to pick with `cwd` instead of committing in one of them, and "git is not installed" is a different
failure from "this is not a repository".

## Platforms

| Capability | Windows | macOS / Linux |
|---|---|---|
| Runtime (the plugin itself) | ✅ | ✅ audited: no missed platform branch |
| Installers (path C) | `setup.ps1` (PowerShell) | `setup.sh` (POSIX sh) |
| Uninstall | `setup.ps1 -Uninstall` | `setup.sh <profile> --uninstall` |
| Profile manifest edit | both call the same `lib/profile-edit.mjs` | same |

Audit notes for `index.js` + `lib/*`:

- the only platform branch is `DEV_NULL` (Windows `NUL` vs `/dev/null`), used solely by the **test fixture**
  to isolate git's global config; the plugin's real git calls deliberately keep your global config
  (credential helper, `pull.rebase`, `core.autocrlf` live there, and clearing it would change how your
  repositories behave);
- no hard-coded drive letters, no `C:\`, no dependency on `powershell`; modules use relative `./`
  specifiers (safe on case-sensitive filesystems); temporary directories come from `os.tmpdir()`;
- `setup.sh` avoids two cross-platform traps on purpose: **no `sed -i`** (BSD/macOS and GNU differ) and
  **no `readlink -f`** (absent on macOS), using POSIX `awk` and `cd`+`pwd` instead.

## Self-check

No DSH required, and it never touches your repositories (tests build their own repos under the system temp
directory and delete them):

```bash
npm test                        # = node self-test.mjs && node self-test-git.mjs
node self-test.mjs              # pure logic + packaging/config/skill contracts (64 checks)
node self-test-git.mjs          # real git: porcelain -z framing, rename attribution, version detection, end-to-end commit (20 checks)
node capture-git-format.mjs     # prints raw git -z bytes, for diagnosing framing
```

On Windows with the runtime DSH ships:

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" self-test.mjs
```

One test in `self-test-git.mjs` is **deliberately independent of the implementation**: it asks git the same
question twice — once with `git status --porcelain -z` and once with the plain, non-NUL format — and
requires both to describe the same set of paths. A broken parser therefore fails the test instead of
agreeing with itself.

That test has a history worth keeping: the first `lib/survey.js` imported a function from a module that did
not export it. The ESM link error made the whole plugin graph unevaluable, so neither `git_commit_push` nor
`/commit-push` registered — and the pure-logic test never touched `survey.js`. Both test files now import
the complete module graph explicitly, and `apply()` validates the schema with `toolDefinitionProblems()`
before registering.

The last two sections of `self-test.mjs` check **packaging and runtime contracts** rather than algorithms:

- the declared `dsh.bundle.patch` exists and is non-empty, inserts **exactly one** mount row (two rows mount
  the plugin twice), uses the stable id `git-commit-push` and names this package; neither installer writes a
  mount row of its own;
- **the `files` whitelist covers every relative module the entry point imports** — the classic npm
  publishing accident, where the package installs cleanly and then fails to load;
- the `exports` subpaths, `locale/*.json` and `icon` the Plugins page reads (relative path, allowed type,
  ≤256 KiB);
- every DSH peer is `optional` (otherwise pnpm tries to install a host package into the user's profile),
  plus `dsh.manifestVersion` and `engines.dsh`;
- settings precedence (user file > shipped template) and the rule that **a malformed config must be
  reported**;
- the skill definition parsed from SKILL.md satisfies the registry's `validateRuntimeSkill` rules, and
  `apply()` on a mock host really registers the tool, the command and the skill.

Two small readers exist for exactly the syntax this project writes (the YAML patch, the skill frontmatter):
the package ships zero dependencies, so the test will not pull in a YAML parser to read three lines — and a
line it cannot read fails the test instead of being ignored.

## Layout

```
index.js                 plugin entry: tool definition, /commit-push command, skill registration, orchestration
cordis.patch.yml         the bundle patch: the single mount row (dsh.bundle.patch points at it)
icon.svg                 Plugins page icon (package.json "icon")
locale/en.json           Plugins page display text (meta.title / meta.description, English)
locale/zh.json           same, Chinese
lib/git.js               the only git layer: fixed argv, timeouts, output caps, porcelain parsing, platform probing
lib/analyze.js           change classification + rule-based Conventional Commits + card rendering
lib/survey.js            one repository survey: status / numstat / log / bounded diff
lib/config.js            settings: user file > shipped template > defaults, and reporting a broken file
lib/skill.js             parses SKILL.md into the runtime skill definition (frontmatter included)
lib/profile-edit.mjs     profile manifest editor shared by both installers (idempotent, keeps unknown fields, no BOM, self-verifying)
setup.ps1                Windows install / uninstall (path C)
setup.sh                 macOS / Linux install / uninstall (path C)
self-test.mjs            pure logic + packaging contracts (64 checks)
self-test-git.mjs        real-git integration (20 checks, own temporary repository)
capture-git-format.mjs   prints raw git -z bytes (framing diagnostics)
e2e-check.mjs            calls run() directly, to verify the commit path without restarting DSH
```

Design trade-offs. The tool definition is a **hand-written object** instead of `defineTool(...)`, and the
settings are a **JSON file** instead of a Cordis `Config` schema, because this package **deliberately
imports nothing from `@deepseek-ai/*`**: it may be `link:`ed from outside a profile or sit inside
`node_modules`, and mounting must not fail because the host's module resolution does not reach it.

The price is writing a **real JSON Schema by hand**: `parameters` needs `type: "object"` + `properties` +
`required: []`, and `output.schema`'s `required` must be an **array of strings** — `defineTool`'s
per-property `required: true` form is compiled by `defineTool` itself, and a hand-written definition
carrying it is rejected **at registration time**, taking the whole plugin down.
`toolDefinitionProblems()` is the regression test for that rule.

`exports` carries `./package.json` and `./locale/*` besides `.`: the Plugins page resolves
`<specifier>/package.json` and `<specifier>/locale/en.json` through Node's module resolver
(`readPluginMeta`), and an exports map with only `.` makes both lookups fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, degrading the title to the bare module specifier.

`peerDependencies` declares only `@deepseek-ai/dsh-tools`, marked **optional**: the peer exists so DSH's
compatibility gate (`evaluatePluginCompatibility`, which reads `peerDependencies`) can compare the host
version, and `optional` guarantees pnpm never downloads a host package to satisfy it. The plugin imports
nothing from it.

## The DSH bundle contract (what this package had to learn)

Everything below was verified against the implementation inside the shipped `dsh` bundle
(`packages/boot/plugin-manager`, `packages/boot/app-boot`, `packages/boot/package-manifest`,
`packages/skill/skill`) rather than guessed.

1. **A bundle is a `package.json` with `dsh.bundle.patch`** — one file path or an ordered list of paths,
   relative to the package root. For a name selected in `dsh.profile.bundles` the launcher resolves it with
   `bundlePatchFiles` / `bundlePatchPaths` and applies that patch as one layer. When `dsh.bundle` cannot be
   resolved it throws `profile bundle "…" declares no dsh.bundle in its package.json` and **skips the
   layer** (recorded in `skippedBundles`) instead of failing the boot.
2. **The Plugins page only manages bundles.** `listBundles()` lists a selected name with no `dsh.bundle` as
   `error.code = "not-bundle"` — the sentence the page shows. Enable/disable only change membership in
   `dsh.profile.bundles` (the dependency stays); uninstall touches the dependency. An unselected plain
   dependency is not listed at all.
3. **The compatibility check only looks at `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers**, compares with
   `includePrerelease`, and takes the runtime version from `dsh-app-boot`. `peerDependenciesMeta.optional`
   does not affect it.
4. **`dsh.manifestVersion` and `engines.dsh` are declarative only** — installers and loaders do not enforce
   them — but they are the public author fields documented by `@deepseek-ai/dsh-package-manifest`, so this
   package declares both.
5. **Display metadata** comes from `readPluginMeta`, which resolves `<name>/package.json`,
   `<name>/locale/*.json` and the `icon` field (relative path, SVG/PNG/JPEG/WebP, ≤256 KiB, must stay inside
   the package directory) through Node; `locale/en.json` is the reference file.
6. **Embedded skills** use `ctx.skills.register({ name, description, content, … })`: `name` must match
   `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `description` and `content` must be non-empty strings (re-validated on
   load by `validateDefinition`), the registry fills in the `runtime` provider, and precedence is
   **project > runtime > user**.

Two more traps worth knowing:

- Loader `insert` is append-only and does not deduplicate — the same `id` inserted twice mounts the plugin
  twice, so there must be exactly one mount.
- A profile's `pnpm-workspace.yaml` normally sets `autoInstallPeers: false` and `nodeLinker: hoisted`, so
  peers are never auto-installed and an unmet one is a warning. That is the second reason this package marks
  its peer optional.

## Maintainers: publishing to npm

```sh
npm login                      # or NPM_TOKEN in CI
npm test                       # prepublishOnly runs it too
npm publish                    # publishConfig pins the registry to registry.npmjs.org
```

- `publishConfig.registry` is set explicitly because a machine-level `~/.npmrc` pointing at a read-only
  mirror (npmmirror) would otherwise send `npm publish` to the wrong place.
- Mirrors take a while to sync after a publish, so a user installing immediately may not see the new version.
- Bump the version by SemVer; `dsh.manifestVersion` is the **manifest format** identifier and is unrelated
  to the package version, so it does not move with it.
- When runtime behaviour changes, update `engines.dsh` and the `@deepseek-ai/dsh-tools` peer range together —
  they decide whether the Plugins page reports an incompatibility.

## License

MIT © ygzhang-lab. See [LICENSE](<./LICENSE>).
