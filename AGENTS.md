# AGENTS.md — 给 AI 的项目说明

面向**修改本仓库的编码代理**。目标：读完这一份就够动手，不必再去翻 DSH 宿主代码、不必重新推理架构与历史 bug。
这里只写「看代码看不出来」或「要花很久才能看出来」的事实；能从代码直接读到的细节不重复。

- 语言：面向用户的文档/卡片/提交信息默认**中文**（`defaultLanguage: "zh"` 可切 `en`）；代码注释与标识符英文。
- 包名：`dsh-plugin-git-commit-push`；工具名 `git_commit_push`；斜杠命令 `git-commit-push`；skill 名 `git-commit-push`（**四处同名**，不要引入第二套名字）。
- 当前版本 `1.0.5`（npm 上 `1.0.1`–`1.0.5` 都已发布，`1.0.5` 是 latest）。零运行时依赖。

---

## 1. 它是什么

DSH（DeepSeek Harness）插件：**一次调用**完成「汇总改动 → 生成 Conventional Commits 信息 → **按 `type(scope)` 拆成多次提交** → 按需打标签 → 推送一次」。
两个入口，共用一个编排函数 `run()`：

| 入口 | 谁用 | token |
| --- | --- | --- |
| 工具 `git_commit_push`（`prepare` / `apply` / `auto`） | 模型 | 消耗（参数 + 卡片） |
| 斜杠命令 `/git-commit-push` | 人 | **0**，完全不经过模型 |
| skill `git-commit-push`（`SKILL.md`，挂载时注册） | 模型 | 按需加载 |

**唯一的硬性触发规则**：只有用户明确要求（说「提交/commit/推送/push」）或敲了斜杠命令才执行；**绝不**因为「改完了」「任务完成了」「会话要结束了」自动提交。这条规则写在三处：工具描述、`SKILL.md`、命令描述。插件无法在 `execute` 内强制它——调用发生时决定已经做出——所以这三处文案是唯一的护栏，改文案时不要削弱它。

## 2. 目录与职责

```
index.js                 入口：手写工具定义、/git-commit-push 命令、skill 注册、run/runWithSettings 编排、两张卡片
cordis.patch.yml         组合包 patch：唯一一处挂载行（package.json 的 dsh.bundle.patch 指向它）
git-commit-push.config.json  随包出货的配置模板（也是唯一配置渠道的说明所在）
icon.svg / locale/{zh,en}.json  插件页显示元数据
lib/git.js               唯一与 git 对话的地方：固定 argv 表、超时、输出上限、porcelain/-z 解析、平台探测
lib/analyze.js           改动分类 + 规则化 Conventional Commits 生成 + `planCommits`（按 type(scope) 分组成提交计划）+ prepare 卡片渲染
lib/survey.js            一次仓库摸底：status / numstat / log / 有界 diff
lib/config.js            配置读取（用户文件 > 包内模板 > 内置默认值）+ 字段表 FIELDS + ensureUserConfig（挂载时把可编辑的用户配置生成到 $DSH_HOME）
lib/skill.js             从 SKILL.md 解析运行时 skill 定义
lib/profile-edit.mjs     setup.ps1 / setup.sh 共用的 profile 清单编辑器（幂等、保留未知字段与行位置、内容没变不写文件、自校验；见 §5）
lib/profile-link.mjs     setup.ps1 / setup.sh 共用的 node_modules 条目管理器：清残留项 + `ensureLink` 补链（见 §5）
setup.ps1 / setup.sh     Windows / macOS·Linux 的源码（link:）安装与卸载
self-test.mjs            纯逻辑 + 打包/配置/skill 契约自检（118 项，不需要 DSH、不碰你的仓库）
self-test-git.mjs        真实 git 集成自检（37 项，自建临时仓库）
capture-git-format.mjs   打印真实 git 的 -z 原始字节（分帧问题诊断）
e2e-check.mjs            直接调 run()，用于不重启验证提交路径
```

跨平台：唯一的平台分支是 `DEV_NULL`（测试夹具隔离 git 全局配置用）。插件正式的 git 调用**刻意保留用户全局配置**（凭据助手、`pull.rebase`、`core.autocrlf` 都在那里）。

## 3. 改完必须跑（Windows 用 DSH 自带 node）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node self-test.mjs        # 纯逻辑 + 打包契约，必须 118 passed / 0 failed
& $node self-test-git.mjs    # 真实 git，必须 37 passed / 0 failed
```

两个测试都显式 import 完整模块图（曾有一个「import 了不存在的导出」导致整个插件图无法求值、工具与命令都不注册的真实事故）。改任何模块后先跑它们。

## 4. 请求流水线（改行为时看这里）

`run()`（index.js）→ `runWithSettings()`：

1. `loadSettingsReport()` 读配置（**唯一渠道**：`$DSH_HOME/git-commit-push.config.json` > 包内模板 > 默认值）。文件坏了要在卡片里报出来，不许静默忽略。用户配置文件由 `apply()` 在挂载时用 `ensureUserConfig()` 生成：只在缺失时写、绝不覆盖手改、失败只记日志（不能让插件挂不上）。
2. `survey({ cwd, language, maxFilesShown })`（lib/survey.js）一次拿全：分支、entries、stats、近几条提交、有界 diff、版本号变化、是否无 upstream。**不是仓库 / 干净 / 多仓库**三种情况分别返回不同卡片，不许猜。
3. `prepare` 分支：只回 `renderCard()` 的预览卡片，不动仓库。
4. `apply`/`auto`：`commitPlan()`（index.js）把 `survey` 的 `draft.groups` 变成本次要造的提交列表 → `doCommit()`：`stageAll`（autoAdd）→ `numstat`（**必须 await，否则 +0/-0**，这是修过的真实 bug）→ **逐组 `commit()`**（多组时带 `-- <paths>`，见下）→ 再 `tagDecision()` + `askTag()`（内置提问卡片，不花 token）→ `doTagAndPush()`（**只推一次**）→ `applyCard()`。
5. **提交拆分**：`planCommits()`（lib/analyze.js）按每个文件自己的 `type(scope)` 分组，**每个不同的 `type(scope)` 一次提交**，顺序按 type 固定表 + scope 字典序。只有一族时 `draft.message` 就是那一次提交的信息，且**不传 paths**（走整索引 `git commit -m`，与旧行为逐字节一致）。多族时每组调 `git commit -m <msg> -- <paths>`（git 的 partial commit），组内多于一个文件时正文才写逐文件注释。**rename 必须把 `origPath` 与新路径都放进 paths**，否则只提交新增、把删除留在工作区。多组时 `autoAdd: false` 的部分暂存语义会退化为「按工作区提交这些路径」，这是 git partial commit 的定义，不是 bug。
6. 显式 `tag` 参数视为指令，跳过提问直接打；提问服务不可用/子代理调用/超时 → **一律不打**并在卡片说明。标签指向**最后一次**提交（HEAD）。**自定义标签**：提问卡片的输入框答案在 `answers[].custom`（单选时 `selected` 为空），**custom 优先于 selected**；`askTag` 取 trim 后的 custom 作为标签名，合法性仍由 `doTagAndPush` 的 `tagNameError` 校验（不合法的跳过并写 note）。只读 `selected` 是已修的真实 bug（用户输入了却被当成「不添加」）。`askTag` 已导出供 `self-test.mjs` 用假提问服务测试（4 条），`self-test-git.mjs` 另有一条端到端用例（假 answerer 输入 `release/2024.1`，断言远端真收到这个标签）。
7. 标签发布：分支推成功后，用**单独一条命令**推标签（`git push <remote> refs/tags/<tag>`），这样标签被拒不会与分支被拒混在一起。**本地已存在的标签也要推送**——跳过的是「创建」，不是「发布」（曾经两者一起跳过，标签就永远留在本地）。卡片的 `标签：` 显示本次真正在处理的标签；输出 schema 里的 `tagPushed` 回答「标签到底上没上远端」；`autoPush` 关闭或推送失败时会明确写「标签 X 仅本地（未推送）」。
8. 提交中途失败（hook 拒绝某一组）：**已建成的提交保留、绝不推送**，卡片写「已完成 N/M 次提交，未推送」，输出里的 `commits` 就是已完成数。

**版本号识别**（`versionFileRank`/`isVersionFile` 在 lib/analyze.js，`parseVersion`/`detectVersion` 在 lib/survey.js）：候选文件按 rank 依次是**清单**（`package.json`、`Cargo.toml`、`pyproject.toml` 等，0）→ 路径任一段含 `version`（1）→ `.env*`/`env.*`（2）→ 路径任一段含 `setting`/`config`（3，所以 `settings/version.js`、`config/index.js`、`setting.js`、`config.js` 都覆盖）。键名认 `version` 与 `appVersion`（大小写不敏感；`APP_VERSION`、`VITE_APP_VERSION` 也认）。survey 先用**有界**（≤2 MiB）工作区读取确认内容里真有版本，才去 stage 它——名字匹配不等于候选，避免把无关的 `config.js`/`tsconfig.json` 塞进暂存区。`detectVersion` 按 rank 读 `:file` 与 `HEAD:file`，所以清单永远优先于同批次的 config 模块。**值必须带点号**（`1.2.3`；顶层清单键例外，`"version": "1"` 仍可用）：`version: 2` 是 schema 版本号，不能拿来建议 tag。守着的用例见 `self-test.mjs` 的「version detection (manifest, env and code files)」与 `self-test-git.mjs` 的「version bumps outside package.json」。

卡片契约（**用户明确要求过，不要退回旧形态**）：

- 结果卡片：`结论行` → `检查到 N 个文件改动，本次提交 N 个文件（+X / -Y）`（多次提交时追加 ` · M 次提交`）→ `信息：<标题>`（一次提交）**或** `提交：` + 最多 3 条标题 + 可选 `…另有 N 次提交`（多次提交）→ `标签：` → `推送：` → 可选一条 `说明：`。**不含逐文件注释、不含 git 原始输出**；一次提交时 ≤6 行，多次提交时受「最多 3 条标题」约束。
- `prepare` 卡片首行：`🔎 **检查到 N 个文件改动（未提交）** · \`branch\` · +X / -Y`，之后按 `maxFilesShown` 列文件与每文件拟定注释（这是给模型写标题用的），最后是 `拟定提交（共 N 次，按 type(scope) 拆分）：` + 各次标题；只有一族时退回旧的单行 `拟定标题：`。
- 逐文件注释**只存在于自己那次提交的正文**（`composeMessage`，一族一个文件时不写正文），`git log` 可见。

## 5. 安装相关的坑（含已修复的 ERR_PNPM_EPERM）

**症状**：Plugins 页/npm 安装时报
`[ERR_PNPM_EPERM] [importPackage …\node_modules\dsh-plugin-git-commit-push] EPERM: operation not permitted, rename '…_tmp_<pid>_<n>' -> '…'`，
但重启 DSH 后插件显示已安装。

**已实测的根因**（Node 24 / Windows / NTFS，复现脚本见 `self-test.mjs` 里 `a rename onto an existing non-empty directory fails` 一项）：

- pnpm 导入包的方式是「在目标旁边建 `<dest>_tmp_<pid>_<thread>` → **rename 到 `<dest>`**」；
- rename **无法覆盖已存在且非空的目录** → Windows 报 **EPERM**（POSIX 报 ENOTEMPTY/EEXIST）；
- 目标一旦清空，同样的 rename 立刻成功；
- 经典残留是**上一次 `link:` 安装**（Windows 是 junction，POSIX 是 symlink）而其 checkout 被移动/删除。pnpm 删不掉悬空链接，于是重试到失败；而 DSH 重启后仍能加载残留的那份 → 「报错但装好了」。

**修复**：`lib/profile-link.mjs` 在 `pnpm install` **之前**清掉该残留项。它用 `lstat()` 判断类型，**链接一律 unlink、绝不跟随**（实测：junction 的 `lstat().isSymbolicLink() === true`，`unlinkSync` 成功且目标文件完好；`rmSync(…, {recursive:true})` 在本机也只删链接）。两个安装脚本都只调这个模块，不各自实现——这是「绝不许删错目录」的那一步。
**手工修复**（用户没跑脚本时）：删掉 profile 里的 `node_modules/dsh-plugin-git-commit-push` 再重装。

**第二个坑：pnpm 不会重建它认为已装好的 `link:` 条目（实测，已修）**

- 现象：重跑 `setup.ps1`（脚本自称幂等）→ 清掉条目的那一步照常执行 → `pnpm install` 打印 `Already up to date` → **条目再也不会回来**，profile 静悄悄少了这个插件（下一次启动 DSH 才发现）。
- 根因：只要 profile `package.json` 与 lockfile 一致，pnpm 就完全不再校验 `link:` 条目的存在性；实测 `pnpm install --force` 也一样（同样 `Already up to date`）。第一次安装能建出来，只是因为 manifest 从 `^1.0.4` 变成了 `link:`，触发了 importer 重算。
- 因此 `clearStaleEntry(profileDir, name, expectedTarget)` 多了一个参数：**已经指向本次要装的 checkout 的链接返回 `kept` 并原样保留**（用 `realpathSync` 比对，悬空链接会 throw → 视为不同 → 照常清除）。安装脚本仍在 `pnpm install` **之后**用 `--ensure-link` 兜底：条目缺失时由 `ensureLink()` 补出 pnpm 自己会建的那种 junction/symlink（Windows 用 `'junction'`，免提权），**只填洞、绝不覆盖已存在的东西**。
- 守着的用例：`a link that already points at this checkout is KEPT, not removed`、`ensureLink fills the hole pnpm leaves, and never overwrites anything`、`both installers re-link after pnpm instead of trusting it`（还查两个脚本都带 `--expected-target` / `--ensure-link`）。改这一步前先读这三条。

**第三个坑：清单编辑器会搬运行、并无条件重写文件（已修）**

- 旧 `profile-edit.mjs` 把插件自己的 `dependencies` 键 `delete` 后再赋值、把 bundle 行 filter 掉再 `push` —— 于是**每次重跑安装脚本，插件行都被挪到两个列表的末尾**（`bundles` 的顺序就是加载顺序）。内容没变时它也照写一遍文件（mtime 每次都动）。
- 现在：已存在的键/行**原地更新**（`dependencies[name] = …` 不改变键序；bundle 保留**第一次出现的位置**并去掉重复行——同一 id 两行会被 Loader 挂两次），并且**序列化结果与磁盘一致时直接不写文件**，CLI 报 `already up to date`；两个安装脚本改成原样转述编辑器的结论，不再无条件打印 `package.json updated`（那也是一句不实提示）。
- 纯逻辑已导出（`editManifest` / `editProfileManifest` / `manifestProblem` / `serializeManifest`），守着的用例在 `self-test.mjs` 的「the profile manifest edit keeps the rows where the user put them」一节，共 7 条（含一条真的 spawn CLI 的用例）。

**第四个坑：Plugins 页的卸载不会清掉 `link:` 条目（实测 pnpm 11.7.0）**

- 复现（本机沙箱，真实 pnpm 11.7.0 + 真实 registry）：profile 先以 `link:` 装好（条目是 junction），再把依赖从 manifest 里去掉跑 `pnpm install` —— pnpm 打印 `- dsh-plugin-git-commit-push link:…`，接着 **`Already up to date`，条目原样留着**（目标还在的链接也留，不只是悬空链接）。桌面版 Plugins 页的卸载就是这个行为：只改 profile manifest、再跑 `pnpm install`。
- 后果：紧接着从 npm 装同一个包（`^1.0.5`）就命中第 1 条那个 rename → **EPERM**。真实会话里正是这么发生的：15:31 Plugins 页卸载（日志 `operation-XEdbgd`），15:36 装 npm 版失败（`operation-dTrUPF`）。
- 所以 **Plugins 页的装卸是一条绕过本仓库脚本的第三条路径**，它不会调用 `lib/profile-link.mjs`。要从 `link:` 版换成 npm 版，先跑 `setup.ps1 -Uninstall`，或手工删掉 profile 里 `node_modules/<name>` 那个条目（两个 README 都写了这条手工修复命令）。
- 顺手证伪的三个猜测（都实测过，别再往这些方向查）：① 失败的 rename **碰不到**链接指向的 checkout —— 目标是 junction 还是普通目录，失败后目标文件一个不少（`self-test.mjs` 的 rename 前提用例守着，含 junction 目标那一项）；② 失败条件不是「目标非空」而是「目标存在」：Windows 上 rename 到**空目录**同样报 EPERM（同一条用例）；③ `Remove-Item -Recurse -Force`（Windows PowerShell 5.1）与 Git Bash 的 `rm -rf` 作用在 junction 上都只删链接本身、目标文件一个不少。

其他安装事实：

- `package.json` 的 `dsh.bundle.patch: ./cordis.patch.yml` 是「能被 Plugins 页管理」的唯一条件；没有它就报 `not-bundle`（「这个包没有声明组合包，不能作为插件管理」）。
- Loader 的 `insert` 是**追加**语义且不去重：同一 `id` 插两次 = 挂载两份。挂载行只能出现在 `cordis.patch.yml`，不要写进用户的 profile patch。
- profile 的 `pnpm-workspace.yaml` 通常是 `nodeLinker: hoisted` + `autoInstallPeers: false`：peer 不会自动装（所以 `@deepseek-ai/dsh-tools` 是 optional peer，只为兼容性检查而存在，插件并不 import 它）。
- `files` 白名单必须覆盖入口点 import 的每个相对模块（测试会查）；`exports` 必须保留 `./package.json` 与 `./locale/*`，否则插件页读不到标题——**并且必须映射 `./git-commit-push.config.json` 与 `./cordis.patch.yml`**：文件在 tarball 里、在安装目录里，都不等于能按包名解析到，缺映射就是 `ERR_PACKAGE_PATH_NOT_EXPORTED`（曾真的漏过配置文件）。
- **新版本装不上，多半不是 lockfile，而是 release-age 豁免写成了带版本的形式**：pnpm 的供给链策略按分钟算「发布时长」，`minimumReleaseAgeExclude` 里写 `pkg@1.0.1` 只放行那一个版本，写 `pkg` 才是不限版本。实测：把 profile lock 里本插件的条目整个删掉、重新解析，依然只给 1.0.1；把豁免改成按包名后立刻给最新版。另：`pnpm install` 遵守 lockfile，换不动版本，换版本要用 `pnpm add pkg@x.y.z`。

## 6. DSH 宿主事实（省得重新挖 app.asar）

宿主实现打包在 DSH 安装目录的 `resources/app.asar` 里（Windows：`<安装目录>\resources\app.asar`；macOS：`…/DeepSeek Harness.app/Contents/Resources/app.asar`），内层路径 `dsh/node_modules/@deepseek-ai/…`。
读法：asar 是「8 字节头 + JSON 目录 + 原始文件」，写个几十行的读取器即可 list/extract（本次分析用的脚本在 `%TEMP%\dsh-asar\asar.mjs`，会随会话结束失效；需要时照此重写，10 分钟的事）。

关键结论（都对着实现核对过）：

1. **命令结果只有一个显示通道**：`commands.register()` 的 handler 返回 `{ kind, text }`；executor 把 `command/run` + `command/done` **作为 log-only 事件**写进 session 日志（**没有 `surfaceOp`**），Web 客户端 `dsh-client-ui-chat` 的 `commandDefinition` 按 `commandId` 配对，渲染成 `GenericCommandCard`：折叠一行「命令名 + 摘要」，可展开看全文；`isVisibleChatNode` 只排除 `name === "permission"` 的命令。**插件无法决定它是否被渲染**，也无法在运行中推文字。
2. **插件没有任何「执行中进度」通道**：工具执行上下文只有 `signal/agent/callId`（没有 progress/stream API），命令 handler 只能返回单个结果。所以「执行中只给简要汇总」只能靠 `prepare` 卡片 + 结果卡片实现，不要去找流式 API。
3. **surface 事件只有 5 种**（`system/developer/user/assistant/message`、`tool/result`），全部对模型可见；**不存在「只给 UI 看」的事件类型**。想让插件往会话里塞卡片又不想花 token，是没有办法的——不要试图 append 假事件（会被模型看到，甚至触发 API 报错）。
4. 会话日志是 **`session.v4.jsonl.zstd`，且是多帧追加**：`zlib.zstdDecompressSync()` 只解出第一帧（会误判成「会话是空的」）。要逐帧解：扫 `28 B5 2F FD` 魔数、从每个偏移尝试解压并把结果拼起来。排查「命令到底跑了没有」时这是最快的证据来源（`command/run` / `command/done` 都在里面）。
5. **可视化配置（Cordis `Config` schema）已被本插件移除**：DSH 只为导出了 `Config` 的条目自动生成设置表单，而该表单在受支持的 profile 上从未出现；本仓库因此删掉了 `lib/schema.js`、`uiOverrides`/`resolveSettings` 与 `@deepseek-ai/schemastery` 依赖。**不要再加回来**（`self-test.mjs` 的 `the visual settings form stays removed` 会拦）。配置只有 JSON 文件一条路。
6. 工具定义的 `parameters` / `output.schema` 是**真正的 JSON Schema 子集**：根必须是 `{ type: 'object', properties, required: [] }`，`required` 必须是**字符串数组**（`required: true` 是 `defineTool` 的 DSL 语法，手写定义在**注册时**就会抛错，整个插件都装不上）。`toolDefinitionProblems()` 是这条规则的回归测试。
7. 静默失败的经典陷阱：ESM 链接期错误（import 了不存在的导出）会让 `apply()` 根本不执行 → 工具与命令都不注册，但 DSH 界面看起来只是「没反应」。改完必跑 §3 的两个测试。

## 7. 不要破坏的约束

- **触发策略**（§1）：工具描述 / `SKILL.md` / 命令描述三处同时维护。
- **只推标签时必须显式给 remote**：`git push refs/tags/v1` 会让 git 把 refspec 当成 remote 名而直接致命失败（`does not appear to be a git repository`），标签于是永远留在本地。`lib/git.js` 的 `push()` 因此在「只推标签」时用 `pushRemoteFor()`（`%(push:remotename)`）解析 remote —— 别删那段解析，`self-test-git.mjs` 里四条标签发布用例守着它。
- **git 只走 lib/git.js**，动词表固定；**绝不**改 `.gitignore`、改 git config、`push --force`、`reset --hard`、`git clean`、`checkout -- <path>`、`commit --no-verify`。唯一新增的 argv 形态是 `commit -m <msg> -- <paths>`（git 的 partial commit，**只在多族提交时用**，见 §4.5）与 `symbolic-ref --short HEAD`（未出生分支的只读回退）；推送被拒 → `pull --rebase` 重推一次；rebase 冲突 → 只 abort 自己启动的 rebase。
- **卡片形态**（§4）：结果卡片保持「结论 + 一行数量汇总」，不要再塞逐文件列表。
- **零依赖**：除可选 peer 外不要引入 npm 依赖（`lib/*.mjs` 只用 Node 内置）。
- **`files` 白名单 + `exports`**：加了新的运行时模块/资源，记得进 `files`；任何需要按**包名**解析到的文件（配置模板、组合包 patch）还必须进 `exports`，否则就是 `ERR_PACKAGE_PATH_NOT_EXPORTED`（自检里有一条例会用真实 `node_modules` 链接解析这四个子路径）。
- 两个安装脚本**只做两件事**（写 profile 清单、跑 pnpm），共用 `lib/profile-edit.mjs` 与 `lib/profile-link.mjs`；不要在 shell 里再写一遍「改 JSON」或「删目录」。

## 8. 常见任务

| 任务 | 怎么做 |
| --- | --- |
| 加一个配置项 | `lib/config.js` 的 `DEFAULTS` + `FIELDS` + `normalize()` + `git-commit-push.config.json` 模板；测试会查三处一致。注意**已存在的用户文件不会被改写**（避免覆盖手改），新键只在新建的文件里出现，老文件缺的键走内置默认值 |
| 改卡片文案 | `index.js` 的 `applyCard`（结果）/ `lib/analyze.js` 的 `renderCard`（预览）；同步 `self-test.mjs` 与两个 README |
| 改提交拆分规则 | `lib/analyze.js` 的 `planCommits` / `noteList` / `typeRank` + `index.js` 的 `commitPlan`；同步 §4、`SKILL.md`、两个 README，并补 `self-test.mjs`（分组与卡片）与 `self-test-git.mjs`（真实分次提交、rename、tag 落点） |
| 加一个 git 动作 | 只能加在 `lib/git.js` 的固定 argv 表里，并补 `self-test-git.mjs` |
| 改触发规则 | 同时改 `git_commit_push` 描述、`SKILL.md`、命令 `description` |
| 发布 | `npm test` → 版本按 SemVer 递增（`dsh.manifestVersion` 与包版本无关）→ `npm publish`（`publishConfig` 已钉死官方源） |

## 9. 已知缺口（诚实记录）

- **斜杠命令结果在会话窗口的可见性无法从插件侧保证**：宿主把 `command/done` 作为 log-only 事件写入，由客户端渲染（§6.1）。本仓库有用户实测「命令成功、会话窗口没有卡片」的报告，而对应 session 日志里 `command/done` 的 text 是完整的；插件侧能做的只有把返回文本做成紧凑卡片（已做）。若再次复现，先按 §6.4 解出该会话日志确认宿主是否记录了 `command/done`，再判断是客户端渲染问题还是插件问题。
- **多族提交的固有代价**（都不是 bug，但改代码时别当成 bug 改）：① hook **每次提交跑一遍**，被拒时前面几次提交已经在本地（卡片会说明）；② `autoAdd: false` + 多族时走 git partial commit，即**按工作区**提交这些路径，不再严格按暂存区（单族时仍然是整索引提交，不受影响）；③ 调用方给的一条 `message` 只能落在**最大一族**上，其余族的标题由插件生成——这是「一条标题无法概括几个刻意不同的提交」的直接后果。
- **未出生分支（全新 `git init`、零提交）**：`git rev-parse --abbrev-ref HEAD` 会 fatal，`currentBranch()` 因此回退到 `symbolic-ref --short HEAD`（`self-test-git.mjs` 有一条 `no HEAD yet` 用例守着）。这条曾经真的让全新仓库的首次提交整个失败——`survey()` 的 `Promise.all` 直接 reject。
- `self-test.mjs` 里那条「rename 覆盖非空目录会失败」的检查断言的是**平台前提**，不是本仓库代码；它存在的意义是防止有人把 `lib/profile-link.mjs` 当成多余步骤删掉。Windows 上它另外断言两件事（见 §5 第四个坑）：rename 到**空目录**同样失败，失败的 rename **不动**链接目标。
- 中文文档（`README.md`）与英文文档（`README.en.md`）是两份手写文件，**必须同步改**；它们不在自检覆盖范围内。
