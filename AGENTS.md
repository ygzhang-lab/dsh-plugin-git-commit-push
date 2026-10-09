# AGENTS.md — 给 AI 的项目说明

面向**修改本仓库的编码代理**。目标：读完这一份就够动手，不必再去翻 DSH 宿主代码、不必重新推理架构与历史 bug。
这里只写「看代码看不出来」或「要花很久才能看出来」的事实；能从代码直接读到的细节不重复。

- 语言：面向用户的文档/卡片/提交信息默认**中文**（`defaultLanguage: "zh"` 可切 `en`）；代码注释与标识符英文。
- 包名：`dsh-plugin-git-commit-push`；工具名 `git_commit_push`；斜杠命令 `git-commit-push`；skill 名 `git-commit-push`（**四处同名**，不要引入第二套名字）。
- 当前版本 `1.0.4`（npm 上已发布 `1.0.1`、`1.0.2`、`1.0.3`）。零运行时依赖。

---

## 1. 它是什么

DSH（DeepSeek Harness）插件：**一次调用**完成「汇总改动 → 生成 Conventional Commits 信息 → 提交 → 按需打标签 → 推送」。
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
lib/analyze.js           改动分类 + 规则化 Conventional Commits 生成 + prepare 卡片渲染
lib/survey.js            一次仓库摸底：status / numstat / log / 有界 diff
lib/config.js            配置读取（用户文件 > 包内模板 > 内置默认值）+ 字段表 FIELDS + ensureUserConfig（挂载时把可编辑的用户配置生成到 $DSH_HOME）
lib/skill.js             从 SKILL.md 解析运行时 skill 定义
lib/profile-edit.mjs     setup.ps1 / setup.sh 共用的 profile 清单编辑器（幂等、保留未知字段、自校验）
lib/profile-link.mjs     setup.ps1 / setup.sh 共用的「清掉 node_modules 里的残留项」（见 §5）
setup.ps1 / setup.sh     Windows / macOS·Linux 的源码（link:）安装与卸载
self-test.mjs            纯逻辑 + 打包/配置/skill 契约自检（91 项，不需要 DSH、不碰你的仓库）
self-test-git.mjs        真实 git 集成自检（28 项，自建临时仓库）
capture-git-format.mjs   打印真实 git 的 -z 原始字节（分帧问题诊断）
e2e-check.mjs            直接调 run()，用于不重启验证提交路径
```

跨平台：唯一的平台分支是 `DEV_NULL`（测试夹具隔离 git 全局配置用）。插件正式的 git 调用**刻意保留用户全局配置**（凭据助手、`pull.rebase`、`core.autocrlf` 都在那里）。

## 3. 改完必须跑（Windows 用 DSH 自带 node）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node self-test.mjs        # 纯逻辑 + 打包契约，必须 91 passed / 0 failed
& $node self-test-git.mjs    # 真实 git，必须 28 passed / 0 failed
```

两个测试都显式 import 完整模块图（曾有一个「import 了不存在的导出」导致整个插件图无法求值、工具与命令都不注册的真实事故）。改任何模块后先跑它们。

## 4. 请求流水线（改行为时看这里）

`run()`（index.js）→ `runWithSettings()`：

1. `loadSettingsReport()` 读配置（**唯一渠道**：`$DSH_HOME/git-commit-push.config.json` > 包内模板 > 默认值）。文件坏了要在卡片里报出来，不许静默忽略。用户配置文件由 `apply()` 在挂载时用 `ensureUserConfig()` 生成：只在缺失时写、绝不覆盖手改、失败只记日志（不能让插件挂不上）。
2. `survey({ cwd, language, maxFilesShown })`（lib/survey.js）一次拿全：分支、entries、stats、近几条提交、有界 diff、版本号变化、是否无 upstream。**不是仓库 / 干净 / 多仓库**三种情况分别返回不同卡片，不许猜。
3. `prepare` 分支：只回 `renderCard()` 的预览卡片，不动仓库。
4. `apply`/`auto`：`doCommit()` → `stageAll`（autoAdd）→ `numstat`（**必须 await，否则 +0/-0**，这是修过的真实 bug）→ `commit()`；再 `tagDecision()` + `askTag()`（内置提问卡片，不花 token）→ `doTagAndPush()` → `applyCard()`。
5. 显式 `tag` 参数视为指令，跳过提问直接打；提问服务不可用/子代理调用/超时 → **一律不打**并在卡片说明。
6. 标签发布：分支推成功后，用**单独一条命令**推标签（`git push <remote> refs/tags/<tag>`），这样标签被拒不会与分支被拒混在一起。**本地已存在的标签也要推送**——跳过的是「创建」，不是「发布」（曾经两者一起跳过，标签就永远留在本地）。卡片的 `标签：` 显示本次真正在处理的标签；输出 schema 里的 `tagPushed` 回答「标签到底上没上远端」；`autoPush` 关闭或推送失败时会明确写「标签 X 仅本地（未推送）」。

卡片契约（**用户明确要求过，不要退回旧形态**）：

- 结果卡片：`结论行` → `检查到 N 个文件改动，本次提交 N 个文件（+X / -Y）` → `信息：` → `标签：` → `推送：` → 可选一条 `说明：`。**不含逐文件注释、不含 git 原始输出、≤6 行**。
- `prepare` 卡片首行：`🔎 **检查到 N 个文件改动（未提交）** · \`branch\` · +X / -Y`，之后按 `maxFilesShown` 列文件与每文件拟定注释（这是给模型写标题用的）。
- 逐文件注释**只存在于提交正文**（`buildMessage`），`git log` 可见。

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
- **git 只走 lib/git.js**，动词表固定；**绝不**改 `.gitignore`、改 git config、`push --force`、`reset --hard`、`git clean`、`checkout -- <path>`、`commit --no-verify`。推送被拒 → `pull --rebase` 重推一次；rebase 冲突 → 只 abort 自己启动的 rebase。
- **卡片形态**（§4）：结果卡片保持「结论 + 一行数量汇总」，不要再塞逐文件列表。
- **零依赖**：除可选 peer 外不要引入 npm 依赖（`lib/*.mjs` 只用 Node 内置）。
- **`files` 白名单 + `exports`**：加了新的运行时模块/资源，记得进 `files`；任何需要按**包名**解析到的文件（配置模板、组合包 patch）还必须进 `exports`，否则就是 `ERR_PACKAGE_PATH_NOT_EXPORTED`（自检里有一条例会用真实 `node_modules` 链接解析这四个子路径）。
- 两个安装脚本**只做两件事**（写 profile 清单、跑 pnpm），共用 `lib/profile-edit.mjs` 与 `lib/profile-link.mjs`；不要在 shell 里再写一遍「改 JSON」或「删目录」。

## 8. 常见任务

| 任务 | 怎么做 |
| --- | --- |
| 加一个配置项 | `lib/config.js` 的 `DEFAULTS` + `FIELDS` + `normalize()` + `git-commit-push.config.json` 模板；测试会查三处一致。注意**已存在的用户文件不会被改写**（避免覆盖手改），新键只在新建的文件里出现，老文件缺的键走内置默认值 |
| 改卡片文案 | `index.js` 的 `applyCard`（结果）/ `lib/analyze.js` 的 `renderCard`（预览）；同步 `self-test.mjs` 与两个 README |
| 加一个 git 动作 | 只能加在 `lib/git.js` 的固定 argv 表里，并补 `self-test-git.mjs` |
| 改触发规则 | 同时改 `git_commit_push` 描述、`SKILL.md`、命令 `description` |
| 发布 | `npm test` → 版本按 SemVer 递增（`dsh.manifestVersion` 与包版本无关）→ `npm publish`（`publishConfig` 已钉死官方源） |

## 9. 已知缺口（诚实记录）

- **斜杠命令结果在会话窗口的可见性无法从插件侧保证**：宿主把 `command/done` 作为 log-only 事件写入，由客户端渲染（§6.1）。本仓库有用户实测「命令成功、会话窗口没有卡片」的报告，而对应 session 日志里 `command/done` 的 text 是完整的；插件侧能做的只有把返回文本做成紧凑卡片（已做）。若再次复现，先按 §6.4 解出该会话日志确认宿主是否记录了 `command/done`，再判断是客户端渲染问题还是插件问题。
- `self-test.mjs` 里那条「rename 覆盖非空目录会失败」的检查断言的是**平台前提**，不是本仓库代码；它存在的意义是防止有人把 `lib/profile-link.mjs` 当成多余步骤删掉。
- 中文文档（`README.md`）与英文文档（`README.en.md`）是两份手写文件，**必须同步改**；它们不在自检覆盖范围内。
