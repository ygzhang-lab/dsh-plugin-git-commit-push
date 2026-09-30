# dsh-plugin-git-commit-push

基于 git-commit-push Skill 设计，一次工具调用完成「提交 + 推送」的 DSH 插件， 0 Token 或 极少 Token �消耗。
把原本需要模型跑十来条 shell、读一堆 git 原始输出的流程，压成 **1–2 次工具调用 + 一张紧凑卡片**。
```
改动 → git_commit_push(prepare)          ← 一张卡片，不含 diff
     → 你写 Conventional Commits 信息
     → git_commit_push(apply, message)   → 提交 / tag 询问 / 推送，一张结果卡片
```

- 平台：**Windows 和 macOS/Linux 都可用**（见「跨平台」）
- 工具：`git_commit_push`（`prepare` / `apply` / `auto`）
- 斜杠命令：`/commit-push`

## 触发条件（务必先读）

**只在两种情况下使用，绝不自动触发：**

1. **用户敲斜杠命令 `/commit-push`** —— 由命令直接执行，完全不经过模型；
2. **用户明确要求** git 提交/推送 —— 「提交」「commit」「推送」「push」这类直白指令。

**改完代码、任务完成、会话快结束、用户说「存档」「好了」——都不是触发条件。** 编辑文件不等于要求提交。
拿不准时先问一句，而不是直接提交。

这条规则写在两个模型可见的位置：`git_commit_push` 的工具描述（模型选工具时读到的第一手信息）与本插件配套的 [SKILL.md](<./SKILL.md>)。
插件无法在 `execute` 内强制执行该规则——调用发生时决定已经做出——所以约束只能落在工具描述与 Skill 上。

## 「0 token 完成 commit push」这个表述准确吗？

**部分准确，需要限定。** 准确的划分是「哪条路径、消耗什么」：

| 路径 | 模型 token | 说明 |
|---|---|---|
| **1. 斜杠命令 `/commit-push`** | **0（真的 0）** | 完全不产生模型请求。命令注册表明确：命令的发现、执行与 UI 输出**不产生模型 token**，结果只渲染在 UI 里、**不进对话历史**。这是**唯一**真正 0 token 的路径。 |
| **2. 工具 `git_commit_push(auto)`** | 少量 | 模型要生成这次工具调用（参数 + 思考）。提交信息由插件自己写，所以**没有**第二轮；返回卡片约 200 token。一次往返。 |
| **3. 工具 `prepare` + `apply`（默认）** | 约 2 次往返 | 只有 `prepare` 卡片（约 200 token）和 `apply` 的 `message` 参数进上下文，**不读 diff**。原先要读 `status` + `diff` + `log` 全文。 |

所以：

- 说「**斜杠命令 0 token**」—— 准确。
- 说「**`git_commit_push` 工具 0 token**」—— **不准确**：模型仍要为每次调用付 token（参数 + 卡片）。
- 说「**省 token**」—— 准确，但省的是**比较级**：省掉读 git 原始输出（数千 token → 约 200）与多轮往返。

还有一个**固定成本**必须说清楚：只要插件装着且工具对模型可见，它的 schema（描述约 1.5 KB + 参数）会进入**每次**请求，约 **600 token**。这笔开销在你不提交时也要付。**若你只想用 `/commit-push`、从不让模型调用它**，把工具移出模型可见面（或改用 `deferLoading` 按需加载）可以省掉这笔固定成本——需要的话我可以加。

一句话：**`/commit-push` 是 0 token；工具路径是「更省 token」，不是 0。**

## 跨平台

| 能力 | Windows | macOS / Linux |
|---|---|---|
| 运行时（插件本体） | ✅ | ✅ 已审计：无遗漏的平台分支 |
| 安装脚本 | `setup.ps1`（PowerShell） | `setup.sh`（POSIX sh） |
| 卸载 | `setup.ps1 -Uninstall` | `setup.sh <profile> --uninstall` |
| profile 清单编辑 | 两者调用同一个 `lib/profile-edit.mjs` | 同 |

运行时跨平台审计结果（`index.js` + `lib/*`）：

- 唯一的平台分支是 `DEV_NULL`（Windows `NUL` / 其他 `/dev/null`），只用于**测试夹具**隔离 git 全局配置。插件正式的 git 调用**刻意保留用户全局配置**——凭据助手、`pull.rebase`、`core.autocrlf` 都在那里，清空会改变用户仓库的行为。
- 无硬编码盘符、无 `C:\`、不依赖 `powershell`；模块用相对 `./` 说明符（大小写敏感文件系统上安全）；临时目录统一用 `os.tmpdir()`。
- `setup.sh` 刻意避开两类跨平台陷阱：**不用 `sed -i`**（BSD/macOS 与 GNU 参数不同）、**不用 `readlink -f`**（macOS 无），改用 POSIX `awk` 与 `cd`+`pwd`。
- Windows 的 `setup.ps1` 与 macOS 的 `setup.sh` 共用同一个清单编辑器，避免两份实现漂移。

### 安装（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\local-plugins\dsh-plugin-git-commit-push\setup.ps1"
```

### 安装（macOS / Linux）

```bash
cd ~/.dsh/local-plugins/dsh-plugin-git-commit-push
sh setup.sh            # 不依赖执行位，任何平台都能这样跑
# 或者先赋权：chmod +x setup.sh && ./setup.sh
sh setup.sh desktop    # 指定 profile
sh setup.sh desktop --uninstall
```

需要 `git` 与 Node 20+（DSH 自带 node/pnpm，脚本会优先使用自带的）。

### 用插件页安装 / 管理（推荐）

本包在 `package.json` 里声明了 `dsh.bundle.patch`，也就是说它是 DSH 意义上的**组合包**（bundle）。于是 Settings → Plugins 可以直接管它：

| 动作 | 插件页做什么 |
|---|---|
| **安装** | 安装框里填本地路径（如 `C:\Users\admin\.dsh\local-plugins\dsh-plugin-git-commit-push`）或包名 |
| **启用 / 停用** | 只改 profile `package.json` 的 `dsh.profile.bundles`，依赖保留 |
| **卸载** | 把包从 profile 依赖里移除 |

**为什么之前不行**：没有 `dsh.bundle.patch` 的包在插件页会得到「**这个包没有声明组合包，不能作为插件管理**」（host 侧错误码 `not-bundle`）。管理器只把声明了组合包的包当作可管理的插件——启用/停用/卸载都作用在组合包层上，一个普通依赖没有可切换的层。

**别两种方式一起用**：脚本会删掉自己以前写进 profile patch 的挂载行，插件页装完也不会有第二处挂载（Loader 的 `insert` 是追加语义，同一 id 插两次会挂载两次）。

### 两个脚本都会做两件事（幂等、带备份）

1. `package.json`：`dependencies` 加 `link:` 依赖、`dsh.profile.bundles` 加包名；
2. 在 profile 目录跑 `pnpm install` 建立链接。

挂载行**不在**脚本里：它由本包自己的组合包 patch [cordis.patch.yml](<./cordis.patch.yml>) 提供（`package.json` 的 `dsh.bundle.patch` 指向它），launcher 对每个选中该组合包的 profile 都应用它。脚本保留的第三个动作是**迁移**：老版本曾把同一行写进 profile 的 `cordis.patch.yml`，脚本发现那一段带标记的块就删掉它，避免重复挂载。

**为什么必须声明组合包**：这是**实测**结论，但早期版本的因果搞反了。只把包装进 `dependencies` 与 `dsh.profile.bundles`、而包里**没有** `dsh.bundle.patch` 时，launcher 会抛 `profile bundle "…" declares no dsh.bundle in its package.json` 并**跳过该层**——所以 loader 里完全没有该包的挂载条目。缺的不是“组合包通道”，缺的是“这个包声明自己是组合包”。声明之后，选中它就会应用它自己的 patch，插件页也才认得它。

**宿主代码改动必须重启 DSH**：`patchReload: live` 会重读配置、挂载行与各组合包层，但**不会重新 import ESM 模块**——实测：改完文件后 loader 条目已更新，而 Tool 注册表里仍是旧工具名。所以改代码后要重启；只改 `git-commit-push.config.json` 则下次调用即生效。切换组合包启用状态属于前者之外的 profile 写入，同样以重启最稳。

### 环境变量

- `DSH_HOME`：DSH 主目录，默认 `~/.dsh`（Windows 下默认 `%USERPROFILE%\.dsh`）。macOS 上 DSH 数据目录不同时用它指定。

## 用

```
git_commit_push({ action: "prepare" })                        # 只汇总，不改仓库
git_commit_push({ action: "apply", message: "feat(x): …" })   # 提交 + 推送
git_commit_push({ action: "auto" })                           # 用规则生成的信息直接提交
git_commit_push({ action: "apply", message: "…", tag: "v1.2.3" })
git_commit_push({ action: "prepare", cwd: "/path/to/repo" })   # 会话目录不是仓库时
```

`/commit-push` 变体（**0 token，完全不经过模型**）：
`/commit-push`、`/commit-push --prepare`、`/commit-push --no-push`、`/commit-push --en`、`/commit-push --tag=v1.2.3`、`/commit-push 修复登录超时`。

## 卡片长什么样

```
**git** · `main` · 3 个文件 · +48 / -12
状态：新增 1 / 修改 2
  新增 src/foo/bar.ts +40/-0
  修改 src/foo/baz.ts +8/-10
  删除 src/old.ts
标签依据：版本号 1.2.3 → 1.2.4（package.json）
最近提交风格："feat(ui): 新增主题切换" "fix(api): 修正重试判断"
拟定信息：`feat(foo): 更新 bar`
（仅预览，未提交未推送）
```

提交后：

```
**git commit** · `main` · `a1b2c3d`
信息：feat(foo): 新增 bar 组件
提交文件 3 个 · +48 / -12
标签：v1.2.4
推送：已推送（含标签）
```

## 配置

`git-commit-push.config.json`（与 `index.js` 同目录，改完**下次调用即生效**，无需重启）：

| 键 | 默认 | 说明 |
|---|---|---|
| `autoPush` | `true` | 提交后推送 |
| `autoAdd` | `true` | 提交前 `git add -A` |
| `tagOnVersionChange` | `true` | 版本文件变动 → 询问打 tag |
| `tagOnBreaking` | `true` | 检测到公共声明被删除 → 询问 |
| `tagOnFileCount` | `10` | 改动文件数 ≥ N → 询问（`0` 关闭）|
| `tagPrefix` | `"v"` | 建议标签前缀 |
| `askBeforeTag` | `true` | `false` 则不问，直接打建议标签（唯一会「不问就打」的开关）|
| `askTimeoutMs` | `120000` | 标签询问等待上限 |
| `defaultLanguage` | `"zh"` | 规则生成信息的语言（`zh`/`en`）|
| `maxFilesShown` | `12` | 卡片最多列几个文件 |
| `pinnedIdentity.name/email` | 空 | 非空时以 `-c user.name/-c user.email` **仅对本次提交**生效；不改你的 git 配置 |

## 安全边界

**绝不**：修改 `.gitignore`、改 git config（含 `user.name`/`user.email` 的写入）、`push --force`、`reset --hard`、`git clean`、`checkout -- <path>`、`commit --no-verify`。
`lib/git.js` 是唯一与 git 对话的地方，动词表是固定的——想加破坏性命令，得先改那里。

**自动处理**：无 upstream 时 `push -u origin <当前分支>`；推送被拒（远程有新提交）时 `pull --rebase` 后重推一次；rebase 冲突则**只 abort 本次自己启动的 rebase**（先探测 `rebase-merge`/`rebase-apply`，绝不丢弃你原有的 rebase 进度）并如实报告；tag 已存在或名字非法则跳过并说明。

**打标签从严**：只有你明确同意（或 `askBeforeTag: false`）才会打标签。但**显式传入 `tag` 参数视为指令，直接执行**——不再经过提问（此前这里有个 bug：显式 tag 也会走提问，没有可用提问者时被静默丢弃，实测抓到并修复）。提问服务不可用、你不在现场（子代理调用）、等待超时——一律**不打**，并在卡片里告诉你怎么用 `tag` 参数补打。

**明确不猜**：会话目录不是仓库时，返回其下的候选仓库让你用 `cwd` 指定，**不会**随便挑一个提交。git 未安装与「不是仓库」是两种不同失败，不会互相误报。

## 附：DSH 组合包契约（本包踩过的三个点）

下面三点是照着 `dsh` 打包产物里的实现核对过的（`packages/boot/plugin-manager`、`packages/boot/app-boot`、`packages/boot/package-manifest`），不是推测。

1. **组合包 = `package.json` 里的 `dsh.bundle.patch`**：一个文件路径，或有序的文件路径数组，相对包目录。`dsh.profile.bundles` 里选中的名字，launcher 用 `bundlePatchFiles` / `bundlePatchPaths` 解析后把该 patch 当成一层应用；解析不出 `dsh.bundle` 就抛 `profile bundle "…" declares no dsh.bundle in its package.json` 并**跳过该层**（记进 `skippedBundles`），不会拖垮启动。
2. **插件页只管理组合包**。`listBundles()` 会把「已选中却没有 `dsh.bundle`」的名字列成 `error.code = "not-bundle"`（页面文案就是那句「这个包没有声明组合包，不能作为插件管理」）；启用/停用只改 `dsh.profile.bundles` 的成员关系、保留依赖，卸载才动依赖。未选中的普通依赖干脆不列出来。
3. **兼容性只查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 类型的 peer**，用 `includePrerelease` 参与比较，运行版本取 `dsh-app-boot` 的版本。本包的 `@deepseek-ai/dsh-tools: ^0.2.0-rc.1` 对 0.2.0-rc.2 判定为兼容；`@deepseek-ai/cordis` 不在检查范围内（前缀不匹配）。

顺带两条容易踩的：

- Loader 的 `insert` 是**追加**语义、且不去重——同一个 `id` 插两次就是挂载两份，所以挂载点必须唯一。
- 显示元数据（标题 / 说明 / 图标）由 `readPluginMeta` 通过 Node 解析 `<包名>/package.json` 与 `<包名>/locale/*.json` 得到，`locale/en.json` 是基准文件；因此 `exports` 要放行这两个子路径。

## 自检

装之前先跑，不需要 DSH，也不碰你的仓库（测试在系统临时目录里建自己的仓库，用完删掉）：

```bash
cd ~/.dsh/local-plugins/dsh-plugin-git-commit-push
node self-test.mjs             # 纯逻辑 + 打包契约：分类、信息生成、卡片、参数解析、schema、组合包声明（48 项）
node self-test-git.mjs         # 真实 git：porcelain/-z 分帧、rename 归属、版本号识别、端到端提交（20 项）
node capture-git-format.mjs    # 只打印真实 git 的 -z 原始字节，用于诊断分帧问题
```

Windows 上用 DSH 自带的 node：

```powershell
$n = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $n "$env:USERPROFILE\.dsh\local-plugins\dsh-plugin-git-commit-push\self-test.mjs"
```

`self-test-git.mjs` 里有一条测试**故意独立于实现**：它同时用 `git status --porcelain -z` 和**非 NUL 的普通格式**问 git 同一个问题，要求两者描述同一组路径。这样解析器写错时测试会失败，而不是跟着实现一起错。

这条测试的由来值得记一笔：第一版 `lib/survey.js` 从一个**不导出该名字**的模块 import 了一个函数。ESM 链接期错误让整个插件图无法求值——`git_commit_push` 和 `/commit-push` 都不会注册。而当时的纯逻辑测试因为不 import `survey.js`，根本碰不到它。现在两个测试文件都显式 import 完整模块图，并且 `apply()` 在注册前会用 `toolDefinitionProblems()` 自检 schema。

`self-test.mjs` 最后一节查的是**打包契约**而不是代码：`dsh.bundle.patch` 指向的文件存在且非空、该 patch 只插入**一行**挂载条目（两行就是挂两次）、这行的 `id` 是稳定的 `git-commit-push`、`name` 等于包名、两个安装脚本都不再自己写挂载行、以及插件页要读的 `exports` 子路径与 `locale/*.json` 齐备。它自带一个只认这份 patch 用到的语法的小型 YAML 读取器——本包刻意零依赖，测试不能为了读三行 YAML 引进一个 parser；读不懂的行会让测试**失败**而不是被忽略。

## 结构

```
index.js                 插件入口：工具定义、/commit-push 命令、编排（prepare/apply/auto）
cordis.patch.yml         组合包 patch：唯一一处挂载行（dsh.bundle.patch 指向它）
locale/en.json           插件页显示文本（meta.title / meta.description，英文）
locale/zh.json           同上，中文
lib/git.js               唯一的 git 调用层：固定 argv、超时、输出上限、porcelain 解析、平台探测
lib/analyze.js           改动分类 + 规则化 Conventional Commits 生成 + 卡片渲染
lib/survey.js            一次仓库摸底：status / numstat / log / 有界 diff
lib/config.js            配置读取（JSON + 内置默认值）
lib/profile-edit.mjs     两个安装脚本共用的 profile 清单编辑器（幂等、保留未知字段、无 BOM、自校验）
setup.ps1                Windows 安装 / 卸载
setup.sh                 macOS / Linux 安装 / 卸载
self-test.mjs            纯逻辑 + 打包契约自检（48 项）
self-test-git.mjs        真实 git 集成自检（20 项，自建临时仓库）
capture-git-format.mjs   打印真实 git 的 -z 原始字节（诊断分帧问题）
e2e-check.mjs            直连调用 run()，用于不重启验证提交路径
```

设计取舍：工具定义是**手写对象**而不是 `defineTool(...)`，配置是 **JSON 文件**而不是 Cordis `Config` schema ——
因为插件以 `link:` 形式挂在 profile 外，不依赖宿主把 `@deepseek-ai/*` 解析到本包，装载不会因为模块解析失败而挂掉。

代价是必须手写**真正的 JSON Schema**：`parameters` 需要 `type: "object"` + `properties` + `required: []`，`output.schema` 的 `required` 必须是**字符串数组**（`defineTool` 的 per-property `required: true` 语法只由 `defineTool` 自己编译；手写定义直接送进注册表会被拒，且是在**注册时**抛错，整个插件都装不上）。`toolDefinitionProblems()` 就是这条规则的回归测试。

`exports` 里除 `.` 之外还导出 `./package.json` 与 `./locale/*`：插件页读显示文本时走的是 Node 的模块解析（`readPluginMeta` 解析 `<specifier>/package.json` 与 `<specifier>/locale/en.json`），只有 `.` 的 exports 映射会让这两个查找得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，标题就退化成整串模块说明符。
