---
name: git-commit
description: 仅当用户明确要求时才使用（用户敲 /commit-push 斜杠命令，或直接说「git 提交 / 提交 / commit / 推送 / push」）。用 DSH 的 git_commit_push 工具一步完成：检查仓库、汇总改动、按 Conventional Commits 生成信息、提交、必要时询问打 tag、推送；未初始化 Git 则不做任何操作。绝不自动触发。
---

# Skill: git-commit

## 触发条件（硬性约束）

**只在下面两种情况下使用，任何其他情况都不得触发：**

1. 用户敲了斜杠命令 **`/commit-push`**（此时命令自己跑完，不经过你）；
2. 用户**明确要求** git 提交或推送——「提交」「提交一下」「commit」「推送」「push」「推上去」「git 提交/推送」这类直白指令。

**绝不自动触发。** 即使出现下列情形，也不要调用本工具，也不要主动提议：

- 你或用户改完代码、写完文件之后 —— 改完不等于要提交；
- 一个任务「看起来完成了」「该收尾了」；
- 会话即将结束、上下文快满了；
- 用户说「完成」「好了」「继续」「存档」但没有明说要 commit/push；
- 用户只是让你生成、整理或 review 改动（例如「总结这次改动」），并未要求提交。

拿不准时**先问一句**是否要提交，而不是直接提交。

## 具体动作全部交给工具

动作由 **`git_commit_push` 工具**（DSH 插件 `dsh-plugin-git-commit-push`）完成，**不要**自己敲 `git status` / `git add` / `git commit` / `git push`。

插件在 Host 进程内直接读仓库，只回传一张紧凑卡片（改动文件、行数统计、推断的 type/scope、近几条提交风格、拟定信息）。
所以**不要**读 diff、不要读 `.gitignore`、不要查 `git log` —— 卡片里已经有了，那些输出只会白烧 token。
tag 询问也由插件内置完成（选项框直接弹给用户，不消耗 token），**不要**再用 `ask_user_question` 问 tag。

**省的是什么**：省掉的是「读 git 原始输出」（数千 token → 约 200）与多余往返。工具路径本身**不是** 0 token —— 模型仍要为每次工具调用与卡片付 token；只有用户直接敲 `/commit-push`（完全不经过模型）才是真的 0 token。所以**不要**以「省 token」为理由主动多调一次工具。

插件在 Windows 与 macOS/Linux 上行为一致；`cwd` 参数请用该平台的原生绝对路径（Windows `D:\proj`，macOS `/Users/me/proj`）。

## 用法

用户明确要求提交/推送后（**这是触发之后的动作，不是触发条件**）：

**默认（推荐，质量最好）**：两步入

1. `git_commit_push({ action: "prepare" })` — 只汇总，不改仓库。
2. 依据卡片里的改动内容与最近提交风格，写一条 Conventional Commits 信息，然后
   `git_commit_push({ action: "apply", message: "<type>(<scope>): <中文简述>" })`。
   需要多行 body 时，把首行作 subject、后续行作 body，一起放进 `message`。

**极简（用户说得很随意，如「提一下」）**：`git_commit_push({ action: "auto" })` — 直接用规则生成的信息提交。

**其他参数**：`tag: "v1.2.3"`（明确指定标签，跳过询问）、`push: false`（本次不推送）、`cwd: "<仓库路径>"`（会话目录不是仓库时指定目标）。

## 提交信息规范

格式 `<type>(<scope>): <subject>`，subject 用简体中文，与仓库既有风格一致。类型：`feat` 新功能、`fix` 修复、`docs` 文档、`style` 样式、`refactor` 重构、`perf` 性能、`test` 测试、`build` 构建、`ci` CI、`chore` 杂项。
破坏性变更在 body 里补一行 `BREAKING CHANGE: ...`。

## 边界

- 工具自动处理：`git add -A`、提交、tag 判断与询问、推送、无 upstream 时 `-u origin <当前分支>`、推送被拒时 `pull --rebase` 后重推一次、hook 失败即如实报告（不绕过）。
- 工具**绝不**：修改 `.gitignore`、改 git config、`push --force`、`reset --hard`。
- 未初始化 Git：工具返回「未初始化 Git」卡片，**只回一句提示并结束**，不做任何其他操作。
- 推送失败/冲突/凭据缺失：按卡片里的 `error` 字段如实转述给用户，给出选项（保留本地 / 手动处理），**不要**擅自 force push 或丢弃改动。

## 输出

只向用户展示卡片里的关键结果：改动文件数、提交信息、commit 短 hash、tag、推送结果。不展示推理过程。
