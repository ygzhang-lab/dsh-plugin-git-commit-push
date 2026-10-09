# dsh-plugin-git-commit-push

English | [中文](README.md)

DSH (DeepSeek Harness) Git commit and push plugin, one call to complete: summarize changes, automatically generate commit messages for each changed file according to Conventional Commits, ask for tagging if necessary, and then push to the Git remote repository configured for the current project.

-  Users can complete a commit and push with just a 0 Token through the `/git-commit-push` slash command (without going through the model, as the script automatically generates simple and clear commits according to the rules);
-  DSH can utilize the `git_commit_push` tool, requiring minimal tokens to accomplish high-quality annotations and complete a single commit and push.
  This plugin serves as a tool-based replacement for the earlier `.agents/skills/git-commit-push` Skill. It condenses the process of running dozens of Shell scripts and reading through a pile of raw Git output, which is typically required for pure Skill work, into **1-2 tool invocations + a compact card**.

Installing gives you three surfaces:

| Surface       | Name                                             | Used by                                         |
| ------------- | ------------------------------------------------ | ----------------------------------------------- |
| Tool          | `git_commit_push` (`prepare` / `apply` / `auto`) | the model                                       |
| Slash command | `/git-commit-push`                               | you, **with no model round-trip at all**        |
| Skill         | `git-commit-push`                                | the model, loading the full procedure on demand |

- Platforms: **Windows and macOS / Linux** (see "Platforms")
- Requirements: DSH `>=0.2.0-rc.1 <0.3.0`, Node `>=24`, git `>=2.36`

## Install

### A. Plugins page (recommended)

DSH → **Settings → Plugins** → type the package name into the install field:

```
dsh-plugin-git-commit-push
```

Then **restart DSH**. The same page can **enable / disable / uninstall** it — which is exactly why this
package declares `dsh.bundle.patch` and makes itself a DSH _bundle_. Without that declaration the page
answers every request with **"这个包没有声明组合包，不能作为插件管理"** (host code `not-bundle`).

### B. Command line
> install
dsh plugin --profile <profile> add dsh-plugin-git-commit-push     
```sh
dsh plugin --profile web add dsh-plugin-git-commit-push 
```
> uninstall
dsh plugin --profile <profile> remove dsh-plugin-git-commit-push 
```sh
dsh plugin --profile web remove dsh-plugin-git-commit-push
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

### An install can fail with `[ERR_PNPM_EPERM] [importPackage …\node_modules\dsh-plugin-git-commit-push]`

```
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-plugin-git-commit-push]
EPERM: operation not permitted, rename '...dsh-plugin-git-commit-push_tmp_<pid>_<n>' -> '...dsh-plugin-git-commit-push'
```

**Cause**: pnpm imports a package by building a temporary directory and then **renaming** it onto
`node_modules/<name>`. A rename cannot replace an existing, non-empty directory, so it fails with EPERM
(measured on Windows with Node 24). The classic leftover is an earlier `link:` install — a junction or
symlink — whose checkout was later moved or deleted (a `link:` junction into `~/.dsh/local-plugins/...` is
exactly how this package was installed once). pnpm cannot remove a dangling link, so it retries and then
reports the failure, even though the package is present enough that DSH shows it as installed after a
restart.

**Fix**: `setup.ps1` and `setup.sh` now clear that entry before running `pnpm install`, through the shared,
reviewed [`lib/profile-link.mjs`](./lib/profile-link.mjs) — a link is unlinked, never followed, so the
checkout it points at is untouched (the same module also runs under `--uninstall`).

**Manual repair**, if an install fails this way without the script: delete the stale directory and retry.

```powershell
# Windows
Remove-Item -LiteralPath "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-git-commit-push" -Recurse -Force
```

```bash
# macOS / Linux
rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-plugin-git-commit-push
```

### A new version is published, but the Plugins page will not upgrade (pnpm's release-age policy)

pnpm 11's supply-chain policy refuses versions younger than N minutes, and an exemption written **with a version**
lets exactly that one version through:

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - dsh-plugin-git-commit-push@1.0.1   # only 1.0.1 passes — publishing 1.0.2 changes nothing
```

Drop the version and exempt the **package**, and every future release of this plugin stays installable
(measured: the same empty lock re-resolved to 1.0.1 before the change and to the newest version after it):

```yaml
minimumReleaseAgeExclude:
  - dsh-plugin-git-commit-push
```

Also note that **`pnpm install` honours the lockfile**, so uninstalling and reinstalling from the Plugins page does
not necessarily move you to a new version; to pin one explicitly use
`pnpm add dsh-plugin-git-commit-push@1.0.3` (or the page's update action), which rewrites that lock entry.

### After installing

Once DSH is restarted:

- the model can call `git_commit_push`, and you can type `/git-commit-push`;
- Settings → Plugins lists this package (title "Git 提交与推送", with an icon) and can enable/disable/uninstall it;
- the model's skill catalog contains `git-commit-push`;
- Settings shows **no** configuration form for this plugin (it exports no `Config` schema — see "Settings"):
  the JSON file is the only configuration channel, and a change applies live with no restart.

## Trigger policy (read this first)

**Only two situations may use it; it never fires on its own:**

1. **the user typed the `/git-commit-push` slash command** — the command runs it, no model involved;
2. **the user explicitly asked** to commit and/or push ("commit", "push", "提交", "推送").

**Finishing an edit, completing a task, an almost-over session, or a user saying "save it" are NOT
triggers.** Editing files is not a request to commit them. When in doubt, ask instead of committing.

The rule is stated in three model-visible places: the `git_commit_push` tool description (the first thing
a model reads when choosing a tool), [SKILL.md](./SKILL.md) (registered as an embedded skill at mount
time), and the command description. The plugin cannot enforce it inside `execute` — by then the decision
has already been made.

## Is "0 tokens for commit + push" accurate?

**Partly — it needs qualification.** The honest split is by path:

| Path                                     | Model tokens   | Why                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. `/git-commit-push` slash command**  | **0 (really)** | No model request is made at all. Command discovery, execution and UI output cost no model tokens, and the result is rendered in the UI only — it never enters the transcript. This is the **only** truly 0-token path. |
| **2. `git_commit_push(auto)` tool call** | a few          | The path a plain "commit and push" takes: ONE call, and the model only emits that call (arguments + thinking). The plugin writes the message itself, so there is **no** second round-trip; the card is ~200 tokens. |
| **3. `prepare` + `apply`**               | ~2 round trips | Only when the user wants to choose the message: only the `prepare` card (~200 tokens) and the `apply` `message` argument enter the context — **no diff is read**.                                                    |

So: "the slash command costs 0 tokens" is accurate; "the tool costs 0 tokens" is **not** — the model still
pays for each call. What the plugin saves is **comparative**: reading raw git output (thousands of tokens →
~200) and several round trips.

One **fixed cost** must also be stated: while the plugin is installed and the tool is visible to the model,
its schema (a ~1.5 KB description plus parameters) enters **every** request — roughly **600 tokens**, paid
even when you never commit. If you only want `/git-commit-push` and never let the model call the tool, moving
the tool out of the model-visible surface (or `deferLoading` it) removes that cost.

## Usage

```
git_commit_push({ action: "auto" })                           # a plain "commit and push": one step, no second turn
git_commit_push({ action: "prepare" })                        # survey only, no writes (when the user wants to pick a message)
git_commit_push({ action: "apply", message: "feat(x): …" })   # commit + push using your subject
git_commit_push({ action: "auto", tag: "v1.2.3" })
git_commit_push({ action: "prepare", cwd: "/path/to/repo" })   # session cwd is not the repository
```

A plain "commit and push" is **one** call: `action="auto"` (the slash command takes the same path and lets the
plugin write the message by rule). `prepare` + `apply` is only worth it when the **user wants to choose the
subject**, or wants to review the changes first: `prepare` returns the file list, each file's draft note and a
candidate subject, and you decide the subject after reading it.

`/git-commit-push` variants (**0 tokens, no model involved**):
`/git-commit-push`, `/git-commit-push --prepare`, `/git-commit-push --no-push`, `/git-commit-push --en`, `/git-commit-push --tag=v1.2.3`, `/git-commit-push fix login timeout`.

### What the card looks like

The preview (`prepare` / `/git-commit-push --prepare`) — the first line is the verdict, and every file is
followed by **its own draft note** (this is the human review surface; `maxFilesShown` bounds how many files it lists):

```
🔎 **检查到 3 个文件改动（未提交）** · `main` · +48 / -12
status: 1 added / 1 modified / 1 deleted
  added    src/foo/bar.ts +40/-0 → feat(foo): add bar component
  modified src/foo/baz.ts +8/-10 → fix(foo): correct parseThing decision
  deleted  src/old.ts → refactor: remove old
tag evidence: version 1.2.3 → 1.2.4 (package.json)
recent style: "feat(ui): add theme switch" "fix(api): correct retry decision"
subject: `feat(foo): update bar component`
(preview only — nothing committed, nothing pushed)
```

And after a commit (the result card is only the verdict, one counts summary and `信息` / `标签` / `推送`, plus at
most one `说明：` line):

```
✅ **Git 提交并推送成功** · `main` · `a1b2c3d`
检查到 3 个文件改动，本次提交 3 个文件（+48 / -12）
信息：feat(foo): 更新 bar 组件
标签：v1.2.4
推送：已推送（含标签）
```

The result card **no longer lists the per-file notes**: those notes stay in the **commit body**, where `git log`
shows them (next section). The card exists so a person can confirm the work landed; it is not a process log.

Four outcomes are unmistakable, so a card can no longer be mistaken for "nothing happened":

| First line                      | Meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `✅ **Git 提交并推送成功**`     | committed and pushed                                                  |
| `✅ **Git 提交成功（未推送）**` | committed; `autoPush` is off or this call said `--no-push`            |
| `⚠️ **已提交，但推送失败**`     | the commit is local, the push failed (reason in `说明：`)             |
| `❌ **提交失败**`               | nothing was committed; your changes are untouched in the working tree |

Other states: `ℹ️ **没有需要提交的改动**`, `⚠️ **当前目录不是 Git 仓库**` (with the candidate repositories listed),
`❌ **未初始化 Git**`, `❌ **找不到 git**`.

### Multiple files: one commit, one note per file in the commit body

Several files are still **one commit**, but its **body** carries one typed Conventional note per file instead of a single
sentence pretending to cover all of them:

```
feat(api): 更新 decideRetry

- feat(api): 更新 decideRetry · src/api/retry.ts
- docs: 更新文档 guide · docs/guide.md
- test(api): 新增 retry.test.ts · src/api/retry.test.ts
```

- Those notes live in the **commit body** (`git log` shows them); the result card only carries the counts summary
  and never repeats them.
- Every note describes **that one file**: the type comes from the file itself (`docs/` → `docs:`, `*.test.ts` →
  `test:`), the scope is its directory (dropped when it would only repeat the type, so `docs(docs)` never appears),
  and the summary prefers a symbol the file's own diff declares (`update decideRetry`).
- Supply only a **subject** (a single-line `message`) and the per-file notes are appended for you; supply your own
  body (a multi-line `message`) and it is used **verbatim**, with no generated notes added.
- A **single-file commit has no body** — its subject says it all.
- The body names at most `maxFilesShown` files (12 by default); the rest collapse into `- …另有 N 个文件`.

(Message text is localized: `defaultLanguage: "zh"` or `"en"` — the rule-generated subject and the per-file notes
in the commit body. The card _format_ is Chinese-and-English-mixed by design: the verdict line and the labels are
Chinese in both locales, and the subject follows the message language.)

### What you see in the session

- The plugin **never** prints raw git output and **never** prints a process log: its whole output is the summary
  and the card.
- A slash-command run shows DSH's own command row (running → the result card, expandable) and costs **0 model
  tokens**; a tool call shows the card as that tool call's result.
- DSH gives a command or a tool no mid-run text channel, so there is **no live progress stream** — what you see
  while it runs is DSH's own rendering of the invocation.
- The tool description tells the model not to narrate the steps it took and not to restate the file list.

## Settings

**There is exactly one configuration channel: the JSON file.** The plugin exports **no** Cordis `Config` schema,
there is no row-level `config` layer, and DSH's Settings page shows **no form** for it. The reason is blunt: that
form never actually appeared on the supported profiles, and a configuration surface that silently does nothing is
worse than none — so `lib/schema.js` was deleted, `@deepseek-ai/schemastery` is no longer a dependency, and the
`uiOverrides` / `resolveSettings` row-config layer is gone with them.

**Something to edit is there as soon as you install: the plugin writes the config template to
`<DSH_HOME>/git-commit-push.config.json` when it mounts.** When DSH loads the plugin and that file does not exist
yet, it is generated from the packaged template — every key, with the explanations — so after installing and
restarting DSH you just open `~/.dsh/git-commit-push.config.json` and edit it. No digging through `node_modules`,
and no chance of a reinstall wiping your settings (the file is not inside the package directory). The rules:

- **created only when it is absent** (an exclusive `wx` write, not a check followed by a write), so a file you
  edited by hand always wins and is never overwritten;
- **it can never fail the plugin**: an unwritable home, `$DSH_HOME` pointing at a file and the like only produce a
  log line — the plugin still mounts, using the built-in defaults;
- **deleting it means "back to the defaults"** — the next DSH start generates a fresh copy.

**Two sources, highest first:**

| Layer | Location                                                                                | Written by                                                       |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | `<DSH_HOME>/git-commit-push.config.json` (default `~/.dsh/git-commit-push.config.json`) | **generated by the plugin on first mount**, then edited by you    |
| 2     | the shipped template `git-commit-push.config.json`                                      | the package (replaced by any reinstall)                          |
| —     | built-in defaults                                                                       | whatever none of the above sets                                  |

A missing file is not an error. A file that exists but is not valid JSON is **reported** — the result card
gains a "配置未生效: …" line rather than silently doing nothing. Omitted keys keep their defaults. A change
**needs no DSH restart**: the next tool call or `/git-commit-push` run reads the new values.

| Key                         | Default  | Meaning                                                                                |
| --------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `autoPush`                  | `true`   | push after a successful commit                                                         |
| `autoAdd`                   | `true`   | `git add -A` before committing                                                         |
| `tagOnVersionChange`        | `true`   | ask about a tag when a version file changed                                            |
| `tagOnBreaking`             | `true`   | ask when a public declaration was removed                                              |
| `tagOnFileCount`            | `10`     | ask when ≥ N files changed (`0` disables)                                              |
| `tagPrefix`                 | `"v"`    | suggested tag prefix                                                                   |
| `askBeforeTag`              | `true`   | `false` tags silently (the only "no question" switch)                                  |
| `askTimeoutMs`              | `120000` | how long the tag question waits                                                        |
| `defaultLanguage`           | `"zh"`   | language of the generated message (`zh`/`en`)                                          |
| `maxFilesShown`             | `12`     | how many paths the `prepare` card lists                                                |
| `pinnedIdentity.name/email` | empty    | applied per commit with `-c user.name/-c user.email`; your git config is never written |

> Your user file does not have to be complete: to change one or two keys, write just those keys and the rest keep
> their built-in defaults. The shipped template is the copy that travels with the package, and editing it means
> losing the edit on the next upgrade — keep your own settings in the user file. Field descriptions are Chinese,
> matching the default message language.

Environment: `DSH_HOME` is the DSH home (default `~/.dsh`, Windows `%USERPROFILE%\.dsh`); it also decides
where the user settings file lives.

## The `git-commit-push` skill

[SKILL.md](./SKILL.md) is registered as an **embedded skill** (`ctx.skills.register(...)`) when the
plugin mounts, so there is nothing to copy into a skills directory after an npm install. The skill name
matches the package name (minus the `dsh-plugin-` prefix): the tool, the command, the skill and the npm
package share one name instead of two.

- To **override** it, keep a project-level skill of the same name (`.agents/skills/git-commit-push/SKILL.md`).
  The registry ranks **project > runtime registration**, so your copy wins.
- A host without a skill registry still works: the skill and the `/git-commit-push` command are **optional
  capabilities** (awaited through a scoped `ctx.inject`), and losing either never affects the
  `git_commit_push` tool.
- **Coming from an early revision**: if you manually installed the old SKILL.md into
  `~/.agents/skills/git-commit/`, that is a user-level skill under a _different_ name and will appear next
  to the bundled `git-commit-push`. The package now owns that content, so deleting that directory is
  recommended (or keep it and put your own rules there — different names, so neither shadows the other).

## Safety boundary

**Never**: modify `.gitignore`, write git config (including `user.name`/`user.email`), `push --force`,
`reset --hard`, `git clean`, `checkout -- <path>`, or `commit --no-verify`.
[lib/git.js](./lib/git.js) is the only place that talks to git and its command set is fixed — adding a
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

| Capability                  | Windows                                   | macOS / Linux                         |
| --------------------------- | ----------------------------------------- | ------------------------------------- |
| Runtime (the plugin itself) | ✅                                        | ✅ audited: no missed platform branch |
| Installers (path C)         | `setup.ps1` (PowerShell)                  | `setup.sh` (POSIX sh)                 |
| Uninstall                   | `setup.ps1 -Uninstall`                    | `setup.sh <profile> --uninstall`      |
| Profile manifest edit       | both call the same `lib/profile-edit.mjs` | same                                  |

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
node self-test.mjs              # pure logic + packaging/config/skill contracts (90 checks)
node self-test-git.mjs          # real git: porcelain -z framing, rename attribution, version detection, end-to-end commit, per-file notes, card verdicts (24 checks)
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
`/git-commit-push` registered — and the pure-logic test never touched `survey.js`. Both test files now import
the complete module graph explicitly, and `apply()` validates the schema with `toolDefinitionProblems()`
before registering.

The last few sections of `self-test.mjs` check **packaging and runtime contracts** rather than algorithms:

- the declared `dsh.bundle.patch` exists and is non-empty, inserts **exactly one** mount row (two rows mount
  the plugin twice), uses the stable id `git-commit-push` and names this package; neither installer writes a
  mount row of its own;
- **the `files` whitelist covers every relative module the entry point imports** — the classic npm
  publishing accident, where the package installs cleanly and then fails to load;
- the `exports` subpaths, `locale/*.json` and `icon` the Plugins page reads (relative path, allowed type,
  ≤256 KiB);
- every DSH peer is `optional` (otherwise pnpm tries to install a host package into the user's profile),
  plus `dsh.manifestVersion` and `engines.dsh`;
- **the visual settings form must stay removed**: `@deepseek-ai/schemastery` may not come back as a dependency
  or a peer, `lib/schema.js` may not reappear, `index.js` may not export `Config` or mention `uiOverrides`
  again, and the shipped template may not advertise a form;
- **one configuration channel only, and the field table agrees**: the field table, the built-in defaults and
  the shipped template cannot drift, the user file beats the shipped template, and **a malformed config must
  be reported**;
- **the premise of the `ERR_PNPM_EPERM` fix**: first that a rename onto an existing non-empty directory really
  fails on this platform, then that `lib/profile-link.mjs` unlinks a link without touching the checkout it
  points at, handles a stale directory and an absent entry, refuses a target outside `node_modules`, and that
  both installers run it instead of carrying a copy;
- the skill definition parsed from SKILL.md satisfies the registry's `validateRuntimeSkill` rules, and
  `apply()` on a mock host really registers the tool, the command and the skill.

Two small readers exist for exactly the syntax this project writes (the YAML patch, the skill frontmatter):
the package ships zero dependencies, so the test will not pull in a YAML parser to read three lines — and a
line it cannot read fails the test instead of being ignored.

## Layout

```
index.js                 plugin entry: tool definition, /git-commit-push command, skill registration, orchestration
cordis.patch.yml         the bundle patch: the single mount row (dsh.bundle.patch points at it)
icon.svg                 Plugins page icon (package.json "icon")
locale/en.json           Plugins page display text (meta.title / meta.description, English)
locale/zh.json           same, Chinese
lib/git.js               the only git layer: fixed argv, timeouts, output caps, porcelain parsing, platform probing
lib/analyze.js           change classification + rule-based Conventional Commits + card rendering
lib/survey.js            one repository survey: status / numstat / log / bounded diff
lib/config.js            settings + the field table: user file > template > defaults, and reporting a broken file
lib/skill.js             parses SKILL.md into the runtime skill definition (frontmatter included)
lib/profile-edit.mjs     profile manifest editor shared by both installers (idempotent, keeps unknown fields, no BOM, self-verifying)
lib/profile-link.mjs     stale node_modules entry remover shared by both installers (unlinks a link, never follows it, so ERR_PNPM_EPERM cannot recur)
setup.ps1                Windows install / uninstall (path C)
setup.sh                 macOS / Linux install / uninstall (path C)
self-test.mjs            pure logic + packaging/config contracts (90 checks)
self-test-git.mjs        real-git integration (24 checks, own temporary repository)
capture-git-format.mjs   prints raw git -z bytes (framing diagnostics)
e2e-check.mjs            calls run() directly, to verify the commit path without restarting DSH
```

Design trade-offs. The tool definition is a **hand-written object** instead of `defineTool(...)`, and the runtime
**imports Node built-ins and relative paths only** — there is no host import at all, and nothing depends on whether
the host's module resolution reaches this package: it may be `link:`ed from outside a profile or sit inside
`node_modules`, and mounting must not fail because of either.

The price is writing a **real JSON Schema by hand**: `parameters` needs `type: "object"` + `properties` +
`required: []`, and `output.schema`'s `required` must be an **array of strings** — `defineTool`'s
per-property `required: true` form is compiled by `defineTool` itself, and a hand-written definition
carrying it is rejected **at registration time**, taking the whole plugin down.
`toolDefinitionProblems()` is the regression test for that rule.

`exports` carries `./package.json`, `./locale/*`, `./git-commit-push.config.json` and `./cordis.patch.yml` besides `.`:
the Plugins page resolves `<specifier>/package.json` and `<specifier>/locale/en.json` through Node's module
resolver (`readPluginMeta`), and an exports map with only `.` makes those lookups fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. **The same wall hides the configuration file**: `git-commit-push.config.json`
really is in the tarball and really is in the installed directory, yet without an `exports` mapping any code
that resolves it by package name (`import '<pkg>/git-commit-push.config.json'`) fails — "the package is
installed, but its config template is unreachable". `cordis.patch.yml` is the same class: the launcher reads it
from the package directory today, but resolving it by package name needs the mapping too. A self-check builds a
real `node_modules` link and resolves all four subpaths, so neither can regress.

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
7. **A settings form means the plugin exports a `Config` schema** (schemastery, zod-style). DSH's settings
   service (`@deepseek-ai/dsh-settings` + `@deepseek-ai/dsh-config-editor`) derives a namespace and a form for
   entries that declare one (`SettingsNamespaceView.autoGenerate`), and writes land in that entry's `config`
   in the profile patch. **This package deliberately exports no `Config` any more**: it used to, but that form
   never appeared on the supported profiles, and a configuration surface that silently does nothing is worse
   than none — so the schema, the `uiOverrides` / `resolveSettings` row-config layer and the
   `@deepseek-ai/schemastery` dependency were all removed.
8. **Therefore the JSON file is the only configuration channel.** For a user of this plugin, "configuring" means
   editing `<DSH_HOME>/git-commit-push.config.json` (default `~/.dsh/…`, or the shipped template), and the next
   tool call or `/git-commit-push` run picks it up with no restart; DSH's Settings page shows no form for it, and
   the **Plugin list** tab still only installs / enables / disables / uninstalls — as do the `pluginManager/*`
   RPCs.

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
- This package has **no `dependencies`**: the runtime imports Node built-ins and relative paths only, so there is
  no library that has to be installed alongside it.

## License

MIT © ygzhang-lab. See [LICENSE](./LICENSE).
