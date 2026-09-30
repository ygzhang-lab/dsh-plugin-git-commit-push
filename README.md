# dsh-plugin-git-commit-push

[English](README.en.md) | 中文
DSH（DeepSeek Harness）Git 提交推送插件，一次调用完成：汇总改动，按 Conventional Commits 为每个变更文件自动生成提交信息，必要时询问打标签，然后推送到当前项目配置的 Git 远程仓库。

- 用户可通过 `/git-commit-push` 斜杠命令, 0 Token 即可完成一次提交与推送(不经过模型，脚本自动按规则生成简单明了的 Commits )；
- DSH 可使用 `git_commit_push` 工具, 极少 Token 即可完成高质量的注释和一次提交与推送。

本插件是早期 `.agents/skills/git-commit-push` 这个 Skill 的工具化替代，把纯 Skill 工作需要模型跑十来条 Shell，读一堆 Git 原始输出的流程，压成 **1–2 次工具调用 + 一张紧凑卡片**。

装好之后你得到三样东西：

| 表面     | 名字                                              | 谁用它                       |
| -------- | ------------------------------------------------- | ---------------------------- |
| 工具     | `git_commit_push`（`prepare` / `apply` / `auto`） | 模型                         |
| 斜杠命令 | `/git-commit-push`                                | 人，**完全不经过模型**       |
| Skill    | `git-commit-push`                                 | 模型，按需加载的完整流程说明 |

- 平台：**Windows 与 macOS / Linux 都可用**（见「跨平台」）
- 要求：DSH `>=0.2.0-rc.1 <0.3.0`、Node `>=20`、git `>=2.36`

## 安装

### 方式 A：插件页（推荐）

DSH → **设置 → 插件** → 安装框里填包名：

```
dsh-plugin-git-commit-push
```

装完按提示**重启 DSH**。同一个页面还能**启用 / 停用 / 卸载**它——这正是本包声明
`dsh.bundle.patch`、把自己做成「组合包」（bundle）的原因。没有这个声明的包，插件页会回一句
**「这个包没有声明组合包，不能作为插件管理」**（host 侧错误码 `not-bundle`）。

### 方式 B：命令行

```sh
dsh plugin --profile <profile> add dsh-plugin-git-commit-push     # 装
dsh plugin --profile <profile> remove dsh-plugin-git-commit-push  # 卸
```

`<profile>` 是你的 profile 名（如 `web`、`headless`、自定义名）。装/卸都会改 profile 的
`package.json`（依赖 + `dsh.profile.bundles`），**需要重启 DSH** 才生效。

### 方式 C：源码 / 离线安装（开发用）

克隆本仓库后，用仓库里的脚本把 checkout 以 `link:` 形式挂进 profile：

```powershell
# Windows（默认 profile: desktop）
powershell -ExecutionPolicy Bypass -File .\setup.ps1
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Profile web
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
```

```bash
# macOS / Linux
sh setup.sh              # 默认 profile: desktop
sh setup.sh web          # 指定 profile
sh setup.sh web --uninstall
```

两个脚本做两件事（幂等、带备份）：把 checkout 写成 profile 的 `link:` 依赖、把包名加进
`dsh.profile.bundles`，然后在 profile 目录跑 `pnpm install`。**挂载行不在脚本里**——它由本包自己的
组合包 patch 提供（见「附：DSH 组合包契约」）。脚本还会**清理**老版本写进 profile `cordis.patch.yml`
的那段挂载行，避免同一个 id 被挂两次。

> 三种方式不要混用：同一个包在 profile 里只应有一处挂载。

### 装完确认

重启 DSH 后：

- 模型能看到 `git_commit_push` 工具，输入框里能敲 `/git-commit-push`；
- 设置 → 插件里能看到本包（标题「Git 提交与推送」，带图标），可启用 / 停用 / 卸载；
- 模型技能目录里有 `git-commit-push`；
- 设置里能找到本插件的**配置表单**（11 个字段，改完即时生效、无需重启）。

## 触发条件（务必先读）

**只在两种情况下使用，绝不自动触发：**

1. **用户敲斜杠命令 `/git-commit-push`** —— 由命令直接执行，完全不经过模型；
2. **用户明确要求** git 提交/推送 —— 「提交」「commit」「推送」「push」这类直白指令。

**改完代码、任务完成、会话快结束、用户说「存档」「好了」——都不是触发条件。** 编辑文件不等于要求提交。
拿不准时先问一句，而不是直接提交。

这条规则写在三个模型可见的位置：`git_commit_push` 的工具描述（模型选工具时读到的第一手信息）、
随包出货的 [SKILL.md](./SKILL.md)（挂载时注册为嵌入式 skill），以及命令自身的描述。
插件无法在 `execute` 内强制执行该规则——调用发生时决定已经做出。

## 「0 token 完成 commit push」这个表述准确吗？

**部分准确，需要限定。** 准确的划分是「哪条路径、消耗什么」：

| 路径                                    | 模型 token      | 说明                                                                                                                                        |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 斜杠命令 `/git-commit-push`**      | **0（真的 0）** | 完全不产生模型请求。命令的发现、执行与 UI 输出**不产生模型 token**，结果只渲染在 UI 里、**不进对话历史**。这是**唯一**真正 0 token 的路径。 |
| **2. 工具 `git_commit_push(auto)`**     | 少量            | 模型要生成这次工具调用（参数 + 思考）。提交信息由插件自己写，所以**没有**第二轮；返回卡片约 200 token。一次往返。                           |
| **3. 工具 `prepare` + `apply`（默认）** | 约 2 次往返     | 只有 `prepare` 卡片（约 200 token）和 `apply` 的 `message` 参数进上下文，**不读 diff**。                                                    |

所以：

- 说「**斜杠命令 0 token**」—— 准确。
- 说「**`git_commit_push` 工具 0 token**」—— **不准确**：模型仍要为每次调用付 token（参数 + 卡片）。
- 说「**省 token**」—— 准确，但省的是**比较级**：省掉读 git 原始输出（数千 token → 约 200）与多轮往返。

还有一个**固定成本**必须说清楚：只要插件装着且工具对模型可见，它的 schema（描述约 1.5 KB + 参数）会进入**每次**请求，约 **600 token**。
**若你只想用 `/git-commit-push`、从不让模型调用它**，把工具移出模型可见面（或改用 `deferLoading` 按需加载）可以省掉这笔固定成本。

一句话：**`/git-commit-push` 是 0 token；工具路径是「更省 token」，不是 0。**

## 用

```
git_commit_push({ action: "prepare" })                        # 只汇总，不改仓库
git_commit_push({ action: "apply", message: "feat(x): …" })   # 提交 + 推送
git_commit_push({ action: "auto" })                           # 用规则生成的信息直接提交
git_commit_push({ action: "apply", message: "…", tag: "v1.2.3" })
git_commit_push({ action: "prepare", cwd: "/path/to/repo" })   # 会话目录不是仓库时
```

`/git-commit-push` 变体（**0 token，完全不经过模型**）：
`/git-commit-push`、`/git-commit-push --prepare`、`/git-commit-push --no-push`、`/git-commit-push --en`、`/git-commit-push --tag=v1.2.3`、`/git-commit-push 修复登录超时`。

### 卡片长什么样

预览（`prepare` / `/git-commit-push --prepare`）——第一行就是结论，每个文件后面跟着**它自己的拟定注释**：

```
🔎 **改动预览（未提交）** · `main` · 3 个文件 · +48 / -12
状态：新增 1 / 修改 2
  新增 src/foo/bar.ts +40/-0 → feat(foo): 新增 bar 组件
  修改 src/foo/baz.ts +8/-10 → fix(foo): 修正 parseThing 判断
  删除 src/old.ts → refactor: 移除 old
标签依据：版本号 1.2.3 → 1.2.4（package.json）
最近提交风格："feat(ui): 新增主题切换" "fix(api): 修正重试判断"
拟定标题：`feat(foo): 更新 bar 组件`
（仅预览，未提交未推送）
```

提交后：

```
✅ **Git 提交并推送成功** · `main` · `a1b2c3d`
信息：feat(foo): 更新 bar 组件
提交 3 个文件 · +48 / -12
  - feat(foo): 新增 bar 组件 · src/foo/bar.ts
  - fix(foo): 修正 parseThing 判断 · src/foo/baz.ts
  - refactor: 移除 old · src/old.ts
标签：v1.2.4
推送：已推送（含标签）
```

四种结果一眼可辨，不会再出现「卡片只有一行、以为没干活」：

| 首行                            | 含义                                        |
| ------------------------------- | ------------------------------------------- |
| `✅ **Git 提交并推送成功**`     | 提交也推送了                                |
| `✅ **Git 提交成功（未推送）**` | 提交成功，`autoPush` 关闭或本次 `--no-push` |
| `⚠️ **已提交，但推送失败**`     | 提交在本地，推送失败（`说明：` 里有原因）   |
| `❌ **提交失败**`               | 提交没成功，改动原样留在工作区              |

其他状态：`ℹ️ **没有需要提交的改动**`、`⚠️ **当前目录不是 Git 仓库**`（并列出候选仓库）、`❌ **未初始化 Git**`、`❌ **找不到 git**`。

### 多文件：一次提交，每个文件一行自己的注释

多文件时**仍然是一次提交**，但正文里每个文件一行自己的 Conventional 注释，而不是一句笼统的话盖住所有文件：

```
feat(foo): 更新 bar 组件

- feat(foo): 新增 bar 组件 · src/foo/bar.ts
- fix(foo): 修正 parseThing 判断 · src/foo/baz.ts
- refactor: 移除 old · src/old.ts
```

- 每条注释**只描述那一个文件**：类型取自它自己（`docs/` → `docs:`、`*.test.ts` → `test:`），scope 取它所在的目录（与类型重复时自动省略，不会出现 `docs(docs)`），简述优先用它 diff 里声明的符号（如 `更新 decideRetry`）。
- 你只给**标题**（单行 `message`）时，插件自动补上这些逐文件注释；你自己写了正文（多行 `message`）则**原样使用**，插件不再添加任何注释。
- **单文件提交没有正文**——标题已经说完了。
- 正文最多列 `maxFilesShown` 个文件（默认 12），其余折叠成一行 `- …另有 N 个文件`。

## 配置

**首选：在 DSH 自己的设置里改。** 本插件导出 Cordis `Config` schema，所以它的挂载行接受 `config` 映射——
DSH 的 settings 服务据此自动生成一个命名空间，设置页把它渲染成表单，
`@deepseek-ai/dsh-config-editor` 把选择写进当前 profile 的 `cordis.patch.yml`（就在本包插入的那一行上），
并通过 Loader 立即应用。所有字段都声明为 **volatile**，因此改完**不 remount、不用重启 DSH**，
下一次工具调用就生效。

**三层来源，自上而下覆盖：**

| 层  | 位置                                                                                  | 谁写它                             |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | 挂载行的 `config`（profile 的 `cordis.patch.yml`）                                    | DSH 设置页的表单                   |
| 2   | `<DSH_HOME>/git-commit-push.config.json`（默认 `~/.dsh/git-commit-push.config.json`） | 你自己编辑；`link:`/离线安装的兜底 |
| 3   | 包内模板 `git-commit-push.config.json`                                                | 随包出货                           |
| —   | 内置默认值                                                                            | 兜住以上都没设的字段               |

文件缺失不是错误（用默认值）；文件存在但不是合法 JSON 时，结果卡片里会追加一行
「配置未生效：…」，而不是静默忽略。没写的键保持默认值。

| 键                          | 默认     | 说明                                                                          | 表单 |
| --------------------------- | -------- | ----------------------------------------------------------------------------- | ---- |
| `autoPush`                  | `true`   | 提交后推送                                                                    | ✅   |
| `autoAdd`                   | `true`   | 提交前 `git add -A`                                                           | ✅   |
| `tagOnVersionChange`        | `true`   | 版本文件变动 → 询问打 tag                                                     | ✅   |
| `tagOnBreaking`             | `true`   | 检测到公共声明被删除 → 询问                                                   | ✅   |
| `tagOnFileCount`            | `10`     | 改动文件数 ≥ N → 询问（`0` 关闭）                                             | ✅   |
| `tagPrefix`                 | `"v"`    | 建议标签前缀                                                                  | ✅   |
| `askBeforeTag`              | `true`   | `false` 则不问，直接打建议标签（唯一会「不问就打」的开关）                    | ✅   |
| `askTimeoutMs`              | `120000` | 标签询问等待上限                                                              | ✅   |
| `defaultLanguage`           | `"zh"`   | 规则生成信息的语言（`zh`/`en`）                                               | ✅   |
| `maxFilesShown`             | `12`     | 卡片最多列几个文件                                                            | ✅   |
| `pinnedIdentity.name/email` | 空       | 非空时以 `-c user.name/-c user.email` **仅对本次提交**生效；不改你的 git 配置 | ✅   |

> 表单所在的具体位置取决于你的 DSH 版本（设置里的插件/配置入口）。**设置 → 插件 → 插件列表**那个标签是**只读**的
> （官方描述：inspect plugins _without changing their configuration_），可编辑的表单来自 settings 服务那条路径。
> 字段说明是中文（提交信息的默认语言），DSH 目前没有按字段本地化。

**为什么还需要 JSON 文件**：`Config` schema 需要 `@deepseek-ai/schemastery`。本包把它声明为**普通依赖**，
npm 安装时随包装上；而 `link:`（源码 checkout）安装时 pnpm 不会装链接目标的依赖，宿主的模块解析也未必覆盖到它。
那种情况下插件**照常工作**，只是没有表单（`Config` 为 `undefined`），此时 JSON 文件就是唯一的配置入口——
这也是它继续存在、并且优先级高于模板的原因。

环境变量：

- `DSH_HOME`：DSH 主目录，默认 `~/.dsh`（Windows 下默认 `%USERPROFILE%\.dsh`）。它同时决定用户配置文件的位置。

## Skill `git-commit-push`

包里的 [SKILL.md](./SKILL.md) 在插件挂载时会注册成**嵌入式 skill**（`ctx.skills.register(...)`），
所以装完即用，不需要你手工往技能目录里拷文件。skill 名与包名一致（`dsh-plugin-` 前缀之外的部分）：
工具、命令、skill、npm 包只用一个名字，不必记两套。

- 想**覆盖**它：在工作区放一个同名项目级 skill（`.agents/skills/git-commit-push/SKILL.md`）。注册表按优先级排序，
  **项目级 > 运行时注册**，你自己的版本会生效。
- 环境里没有技能注册表也能正常工作：skill 与 `/git-commit-push` 命令都是**可选能力**（用 scoped
  `ctx.inject` 等它出现），缺任何一个都不影响 `git_commit_push` 工具本身。
- **从早期版本迁过来**：如果你曾把老 SKILL.md 手工装到 `~/.agents/skills/git-commit/`，那是一份**另一个名字**的
  用户级 skill，会与随包的 `git-commit-push` 同时出现在技能目录里。内容已被本包接管，建议删掉那个目录
  （或保留它并在里面写你自己的规则——两者名字不同，互不覆盖）。

## 安全边界

**绝不**：修改 `.gitignore`、改 git config（含 `user.name`/`user.email` 的写入）、`push --force`、`reset --hard`、`git clean`、`checkout -- <path>`、`commit --no-verify`。
[lib/git.js](./lib/git.js) 是唯一与 git 对话的地方，动词表是固定的——想加破坏性命令，得先改那里。

**自动处理**：无 upstream 时 `push -u origin <当前分支>`；推送被拒（远程有新提交）时 `pull --rebase` 后重推一次；rebase 冲突则**只 abort 本次自己启动的 rebase**（先探测 `rebase-merge`/`rebase-apply`，绝不丢弃你原有的 rebase 进度）并如实报告；tag 已存在或名字非法则跳过并说明。

**打标签从严**：只有你明确同意（或 `askBeforeTag: false`）才会打标签。但**显式传入 `tag` 参数视为指令，直接执行**——不再经过提问（此前这里有个 bug：显式 tag 也会走提问，没有可用提问者时被静默丢弃，实测抓到并修复）。提问服务不可用、你不在现场（子代理调用）、等待超时——一律**不打**，并在卡片里告诉你怎么用 `tag` 参数补打。

**明确不猜**：会话目录不是仓库时，返回其下的候选仓库让你用 `cwd` 指定，**不会**随便挑一个提交。git 未安装与「不是仓库」是两种不同失败，不会互相误报。

## 跨平台

| 能力               | Windows                               | macOS / Linux                    |
| ------------------ | ------------------------------------- | -------------------------------- |
| 运行时（插件本体） | ✅                                    | ✅ 已审计：无遗漏的平台分支      |
| 安装脚本（方式 C） | `setup.ps1`（PowerShell）             | `setup.sh`（POSIX sh）           |
| 卸载               | `setup.ps1 -Uninstall`                | `setup.sh <profile> --uninstall` |
| profile 清单编辑   | 两者调用同一个 `lib/profile-edit.mjs` | 同                               |

运行时跨平台审计结果（`index.js` + `lib/*`）：

- 唯一的平台分支是 `DEV_NULL`（Windows `NUL` / 其他 `/dev/null`），只用于**测试夹具**隔离 git 全局配置。插件正式的 git 调用**刻意保留用户全局配置**——凭据助手、`pull.rebase`、`core.autocrlf` 都在那里，清空会改变用户仓库的行为。
- 无硬编码盘符、无 `C:\`、不依赖 `powershell`；模块用相对 `./` 说明符（大小写敏感文件系统上安全）；临时目录统一用 `os.tmpdir()`。
- `setup.sh` 刻意避开两类跨平台陷阱：**不用 `sed -i`**（BSD/macOS 与 GNU 参数不同）、**不用 `readlink -f`**（macOS 无），改用 POSIX `awk` 与 `cd`+`pwd`。

## 自检

不需要 DSH，也不碰你的仓库（测试在系统临时目录里建自己的仓库，用完删掉）：

```bash
npm test                        # = node self-test.mjs && node self-test-git.mjs
node self-test.mjs              # 纯逻辑 + 打包 / 配置 / 表单 / skill 契约（86 项）
node self-test-git.mjs          # 真实 git：porcelain/-z 分帧、rename 归属、版本号识别、端到端提交、逐文件注释、卡片结论（24 项）
node capture-git-format.mjs     # 只打印真实 git 的 -z 原始字节，用于诊断分帧问题
```

Windows 上用 DSH 自带的 node：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" self-test.mjs
```

`self-test-git.mjs` 里有一条测试**故意独立于实现**：它同时用 `git status --porcelain -z` 和**非 NUL 的普通格式**问 git 同一个问题，要求两者描述同一组路径。这样解析器写错时测试会失败，而不是跟着实现一起错。

这条测试的由来值得记一笔：第一版 `lib/survey.js` 从一个**不导出该名字**的模块 import 了一个函数。ESM 链接期错误让整个插件图无法求值——`git_commit_push` 和 `/git-commit-push` 都不会注册。而当时的纯逻辑测试因为不 import `survey.js`，根本碰不到它。现在两个测试文件都显式 import 完整模块图，并且 `apply()` 在注册前会用 `toolDefinitionProblems()` 自检 schema。

`self-test.mjs` 最后两节查的是**打包与运行时契约**，不是算法：

- `dsh.bundle.patch` 指向的文件存在且非空、该 patch 只插入**一行**挂载条目（两行就是挂两次）、`id` 是稳定的 `git-commit-push`、`name` 等于包名、两个安装脚本都不再自己写挂载行；
- **`files` 白名单是否覆盖入口点 import 的每一个相对模块**——这是 npm 发布最常见的翻车点：包能装上，一加载就找不到模块；
- 插件页要读的 `exports` 子路径、`locale/*.json`、`icon`（相对路径、类型、≤256 KiB）；
- 每个 DSH peer 都是 `optional`（否则 pnpm 会试图把宿主包装进用户 profile）、`dsh.manifestVersion`、`engines.dsh`；
- **配置三层来源与字段表的一致性**：字段表 ↔ 内置默认值 ↔ 包内模板三者不许漂移、UI（挂载行 config）胜过 JSON 文件、`pinnedIdentity` 按 key 合并、以及"只有与默认值不同的解析值才算用户改过"这条判定；
- **设置表单可发布或可降级**：`@deepseek-ai/schemastery` 能解析时 `Config` 必须建出来且每个字段都是 volatile；解析不到时 `Config` 必须是 `undefined` 且**工具照样注册**；
- 配置优先级（用户文件 > 包内模板）与**损坏的配置必须被报告**；
- SKILL.md 解析出的 skill 定义满足注册表 `validateRuntimeSkill` 的规则，且 `apply()` 在模拟宿主上确实注册了工具 + 命令 + skill。

它自带两个只认本项目所用语法的小型读取器（YAML patch、skill frontmatter）——本包刻意零依赖，测试不能为了读三五行 YAML 引进一个 parser；读不懂的行会让测试**失败**而不是被忽略。

## 结构

```
index.js                 插件入口：工具定义、/git-commit-push 命令、skill 注册、编排（prepare/apply/auto）
cordis.patch.yml         组合包 patch：唯一一处挂载行（dsh.bundle.patch 指向它）
icon.svg                 插件页图标（package.json 的 icon）
locale/en.json           插件页显示文本（meta.title / meta.description，英文）
locale/zh.json           同上，中文
lib/git.js               唯一的 git 调用层：固定 argv、超时、输出上限、porcelain 解析、平台探测
lib/analyze.js           改动分类 + 规则化 Conventional Commits 生成 + 卡片渲染
lib/survey.js            一次仓库摸底：status / numstat / log / 有界 diff
lib/config.js            配置读取 + 字段表：挂载行 config > 用户文件 > 模板 > 默认值，并报告损坏的文件
lib/schema.js            Cordis Config（schemastery）：可视化表单 + volatile 字段；库不可达时优雅降级
lib/skill.js             从 SKILL.md 解析出运行时 skill 定义（含 frontmatter 解析）
lib/profile-edit.mjs     两个安装脚本共用的 profile 清单编辑器（幂等、保留未知字段、无 BOM、自校验）
setup.ps1                Windows 安装 / 卸载（方式 C）
setup.sh                 macOS / Linux 安装 / 卸载（方式 C）
self-test.mjs            纯逻辑 + 打包 / 配置 / 表单契约自检（86 项）
self-test-git.mjs        真实 git 集成自检（24 项，自建临时仓库）
capture-git-format.mjs   打印真实 git 的 -z 原始字节（诊断分帧问题）
e2e-check.mjs            直连调用 run()，用于不重启验证提交路径
```

设计取舍：工具定义是**手写对象**而不是 `defineTool(...)`；运行时的宿主 import 只有一处例外——
`lib/schema.js` 用 `createRequire` 取 `@deepseek-ai/schemastery` 来声明 `Config`，而且**整段包在 try/catch 里**：
取不到就 `Config === undefined`（没有表单），插件与工具照常工作。其余模块仍然只 import Node 内置与相对路径，
因为本包既可能以 `link:` 挂在 profile 外，也可能以 npm 包形式躺在 `node_modules` 里，
装载不应因为宿主的模块解析没覆盖到本包而失败。（`@deepseek-ai/schemastery` 声明为普通 `dependencies`，
npm 安装时随包装上；`link:` 安装时 pnpm 不装链接目标的依赖，所以这条降级路径是真实存在的，不是理论情况。）

代价是必须手写**真正的 JSON Schema**：`parameters` 需要 `type: "object"` + `properties` + `required: []`，`output.schema` 的 `required` 必须是**字符串数组**
（`defineTool` 的 per-property `required: true` 语法只由 `defineTool` 自己编译；手写定义直接送进注册表会被拒，且是在**注册时**抛错，整个插件都装不上）。`toolDefinitionProblems()` 就是这条规则的回归测试。

`exports` 里除 `.` 之外还导出 `./package.json` 与 `./locale/*`：插件页读显示文本时走的是 Node 的模块解析（`readPluginMeta` 解析 `<specifier>/package.json` 与 `<specifier>/locale/en.json`），只有 `.` 的 exports 映射会让这两个查找得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，标题就退化成整串模块说明符。

`peerDependencies` 只声明 `@deepseek-ai/dsh-tools` 且标为 **optional**：它的作用是让 DSH 的兼容性检查
（`evaluatePluginCompatibility`，只读 `peerDependencies`）能拿宿主版本比对；标 optional 则保证 pnpm
永远不会为了满足它去下载宿主包。本包实际不 import 它。

## 附：DSH 组合包契约（本包踩过的几个点）

以下各点都照着 `dsh` 打包产物里的实现核对过（`packages/boot/plugin-manager`、`packages/boot/app-boot`、
`packages/boot/package-manifest`、`packages/skill/skill`），不是推测。

1. **组合包 = `package.json` 里的 `dsh.bundle.patch`**：一个文件路径，或有序的文件路径数组，相对包目录。`dsh.profile.bundles` 里选中的名字，launcher 用 `bundlePatchFiles` / `bundlePatchPaths` 解析后把该 patch 当成一层应用；解析不出 `dsh.bundle` 就抛 `profile bundle "…" declares no dsh.bundle in its package.json` 并**跳过该层**（记进 `skippedBundles`），不会拖垮启动。
2. **插件页只管理组合包**。`listBundles()` 会把「已选中却没有 `dsh.bundle`」的名字列成 `error.code = "not-bundle"`（页面文案就是那句「这个包没有声明组合包，不能作为插件管理」）；启用/停用只改 `dsh.profile.bundles` 的成员关系、保留依赖，卸载才动依赖。未选中的普通依赖干脆不列出来。
3. **兼容性只查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 类型的 peer**，用 `includePrerelease` 参与比较，运行版本取 `dsh-app-boot` 的版本。`peerDependenciesMeta.optional` 不影响这项检查。
4. **`dsh.manifestVersion` 与 `engines.dsh` 目前只作声明**（安装器与 loader 都不强制），但它们是 `@deepseek-ai/dsh-package-manifest` 记载的公开作者字段，所以本包照写。
5. **显示元数据**由 `readPluginMeta` 通过 Node 解析 `<包名>/package.json`、`<包名>/locale/*.json` 与 `package.json` 的 `icon`（相对路径、SVG/PNG/JPEG/WebP、≤256 KiB、必须留在包目录内）得到，`locale/en.json` 是基准文件。
6. **嵌入式 skill** 用 `ctx.skills.register({ name, description, content, … })`：`name` 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，`description` 与 `content` 必须是非空字符串（加载时按 `validateDefinition` 再校验一次），`provider` 由注册表填成 `runtime`，优先级为 **项目级 > 运行时 > 用户级**。
7. **可视化配置 = 导出 `Config` schema（schemastery，zod 风格）。** DSH 的设置服务（`@deepseek-ai/dsh-settings` + `@deepseek-ai/dsh-config-editor`）为声明了 `Config` 的条目自动生成命名空间与表单（`SettingsNamespaceView.autoGenerate`），写入落到该条目在 profile patch 里的 `config`；插件可 `settings.configure({ auto: false })` 退出自动表单。**被 `.volatile()` 标记的字段**只提交新值并广播 `loader/volatile-update`（Loader 用 `equalExceptVolatile` 比较），**不 remount**；普通字段变化会重新挂载该行。volatile 的放置有硬规则：必须在固定对象路径上，不能落在 dict 值、数组项、map key 或 union/lazy 分支里（`validateVolatileSchema` 会抛错）。
8. **设置页不是万能的**：`@deepseek-ai/dsh-settings` 只展示"活动且可唯一定位条目的 volatile 字段"，**插件列表**标签是只读的，而 `pluginManager/*` 那套 RPC 只负责装/启用/停用/卸载——所以"能可视化配置"的唯一条件是**插件自己声明 `Config`**。

另外两条容易踩的：

- Loader 的 `insert` 是**追加**语义、且不去重——同一个 `id` 插两次就是挂载两份，所以挂载点必须唯一。
- profile 的 `pnpm-workspace.yaml` 通常带 `autoInstallPeers: false` 与 `nodeLinker: hoisted`：peer 不会被自动安装，未满足时只有一行警告。这也是本包把 peer 标成 optional 的原因之一。

## 维护者：发布到 npm

```sh
npm login                      # 或 CI 里的 NPM_TOKEN
npm test                       # prepublishOnly 也会跑一遍
npm publish                    # publishConfig 已把 registry 固定为 registry.npmjs.org
```

- `publishConfig.registry` 显式写成 npm 官方源：本机 `~/.npmrc` 若指向 npmmirror（只读镜像），不加这一行容易把 `npm publish` 发到镜像上而失败。
- 发布后 npmmirror 等镜像有同步延迟，用户立刻装可能拿不到最新版。
- 版本按 SemVer 递增；`dsh.manifestVersion` 是**清单格式**标识，与包版本无关，不要跟着改。
- 改了运行时行为就同步 `engines.dsh` 与 `peerDependencies` 里 `@deepseek-ai/dsh-tools` 的范围，两者决定插件页会不会给出「与 DSH 不兼容」的提示。
- `dependencies` 里的 `@deepseek-ai/schemastery` 是**真实依赖**（设置表单要用）：用户那边由 pnpm 正常安装。
  改它的范围前先确认目标 DSH 版本里 schema API（`.default/.description/.min/.volatile`）没变，否则表单会走降级路径
  （`Config === undefined`，功能不受影响但没有可视化配置）。

## 许可

MIT © ygzhang-lab。见 [LICENSE](./LICENSE)。
