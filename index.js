/**
 * dsh-plugin-git-commit-push — a one-call Conventional-Commits workflow for DSH.
 *
 * WHY THIS EXISTS
 * The skill it replaces asks a model to run `git status`, read `.gitignore`,
 * inspect a diff, call `git log` for tone, write a message, then commit, tag and
 * push — ten-odd tool calls whose OUTPUT is mostly raw git text. A plugin does
 * the reading in-process, where bytes are free, and hands back one compact card.
 * The model pays for a summary instead of a diff, and pays for a question only
 * when a tag is genuinely warranted (the in-plugin question costs no tokens at
 * all, because it never becomes a model message).
 *
 * WHEN IT MAY BE USED — the trigger policy
 * ONLY when the user asks for it: they typed the `/git-commit-push` slash command,
 * or they said in words that they want a commit and/or push. There is no
 * automatic path. Finishing an edit, completing a task, or approaching the end
 * of a session is NOT a trigger, and the tool description states this to the
 * model in the strongest terms available. The plugin cannot enforce the rule
 * from inside `execute` — by then the decision has already been made — so the
 * enforcement lives in the tool description (which the model reads when
 * choosing a tool) and in the accompanying SKILL.md.
 *
 * WHAT IT WILL NOT DO
 * Never modifies `.gitignore`, git config or `user.name`/`user.email`; never
 * `push --force`, `reset --hard`, `clean`, or `checkout --` (see lib/git.js for
 * the fixed command set); never commits in a container directory — it reports
 * the candidate repositories instead.
 */
import {
  loadSettingsReport, CONFIG_PATH, userConfigPath, configCandidates,
} from './lib/config.js'
import { skillDefinition } from './lib/skill.js'
import { survey } from './lib/survey.js'
import {
  commit, createTag, headShort, numstat, push, pushAfterRebase,
  stageAll, tagExists, tagNameError,
} from './lib/git.js'
import { renderCard, totalsOf } from './lib/analyze.js'

export const name = 'git-commit-push'
export const inject = ['tools']

/**
 * Tool name the model sees. Underscored, not hyphenated: DSH tool names use
 * snake_case (`read_image`, `web_fetch`), and the skill references this exact
 * string.
 */
export const TOOL_NAME = 'git_commit_push'

/** Slash command name, without the leading slash. */
export const COMMAND_NAME = 'git-commit-push'

/**
 * Reduce any thrown value to one bounded, printable line.
 *
 * Git stderr can be long and multi-line; a commit failure should not push a
 * screenful of remote narration into the transcript.
 */
function brief(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/** The session working directory, with the host process cwd as last resort. */
function cwdOf(exec) {
  const header = exec?.agent?.session?.header?.cwd
  if (typeof header === 'string' && header !== '') return header
  return process.cwd()
}

/**
 * Whether the settings ask for a tag question, and what name to suggest.
 *
 * @returns {{ shouldAsk: boolean, tag?: string, reasons: string[] }}
 */
function tagDecision(surveyResult, settings, override) {
  const reasons = []
  if (settings.tagOnVersionChange && surveyResult.version !== undefined) {
    reasons.push(`版本号 ${surveyResult.version.from ?? '?'} → ${surveyResult.version.to ?? '?'}`)
  }
  if (settings.tagOnBreaking && surveyResult.breaking) reasons.push('可能的破坏性变更')
  if (settings.tagOnFileCount > 0 && surveyResult.entries.length >= settings.tagOnFileCount) {
    reasons.push(`改动文件 ${surveyResult.entries.length} 个`)
  }

  let tag = override
  if (tag === undefined && reasons.length > 0) {
    const version = surveyResult.version?.to
    if (typeof version === 'string' && version !== '') {
      tag = version.startsWith(settings.tagPrefix) ? version : `${settings.tagPrefix}${version.replace(/^v/, '')}`
    } else {
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      tag = `${settings.tagPrefix}${stamp}`
    }
  }
  return { shouldAsk: reasons.length > 0, ...(tag === undefined ? {} : { tag }), reasons }
}

/**
 * Ask the user to confirm a tag, from inside the tool call.
 *
 * This is the token-saving move the skill cannot make: the question is answered
 * in the plugin's own UI card and never becomes a model message.
 *
 * Failure policy: when the question cannot be asked at all (a delegated caller
 * has no human answerer, an older host lacks the service, or the wait times
 * out) the plugin does NOT tag. Creating a release tag is an outward-facing,
 * hard-to-undo act, so "nobody answered" must mean "do not", and the note tells
 * the caller exactly how to force it. Only `askBeforeTag: false` tags silently,
 * because that is the user explicitly opting in.
 *
 * @returns {Promise<{ decided: string | undefined, via: 'user' | 'auto' | 'skipped', note?: string }>}
 */
async function askTag(ctx, exec, tag, reasons, settings) {
  if (tag === undefined) return { decided: undefined, via: 'skipped' }
  if (settings.askBeforeTag !== true) return { decided: tag, via: 'auto' }
  // A question needs a live caller to answer it. Without one (a direct `run`
  // call with no tool context) there is nothing to ask, and the safe answer is
  // the same as everywhere else in this function: do not tag.
  if (exec?.agent === undefined) {
    return { decided: undefined, via: 'skipped', note: `没有可询问的会话上下文，本次未打标签（可用 tag 参数指定 ${tag}）` }
  }

  const service = ctx.get('userQuestions')
  if (service === undefined) {
    return { decided: undefined, via: 'skipped', note: `未安装提问服务，本次未打标签（可用 tag 参数指定 ${tag}）` }
  }

  const questions = [{
    id: 'git-commit-push-tag',
    header: 'Git 标签',
    question: `本次改动满足打标签条件（${reasons.join('；')}）。是否创建标签 ${tag}？`,
    options: [
      { label: `添加 ${tag}`, description: `创建标签 ${tag} 并随分支一起推送` },
      { label: '不添加', description: '只提交并推送提交，不创建标签' },
    ],
  }]
  const request = { agent: exec.agent, signal: exec.signal, questions }

  try {
    const timed = typeof service.askTimed === 'function'
    const answer = timed
      ? await service.askTimed(request, exec.callId, settings.askTimeoutMs)
      : await service.ask(request)

    if (timed && answer !== null && typeof answer === 'object' && 'pending' in answer) {
      return { decided: undefined, via: 'skipped', note: `等待标签确认超时，本次未打标签（可用 tag 参数指定 ${tag}）` }
    }
    const selected = answer?.answers?.find(item => item.id === 'git-commit-push-tag')?.selected?.[0]
    if (typeof selected === 'string' && selected.startsWith('添加')) return { decided: tag, via: 'user' }
    return { decided: undefined, via: 'user' }
  } catch (error) {
    const message = brief(error)
    // Match the documented error CODES, not just their names: the service
    // reports `DELEGATED_CALLER`/`CALLER_NOT_LIVE` in `error.code` as well as in
    // the message, and a host that reworded the message must not change whether
    // we tag.
    const code = typeof error?.code === 'string' ? error.code : ''
    const delegated = /DELEGATED_CALLER|CALLER_NOT_LIVE/.test(code) || /DELEGATED_CALLER|CALLER_NOT_LIVE/.test(message)
    return {
      decided: undefined,
      via: 'skipped',
      note: delegated
        ? `当前上下文无法询问用户，本次未打标签（可用 tag 参数指定 ${tag}）`
        : `标签确认失败（${message}），本次未打标签（可用 tag 参数指定 ${tag}）`,
    }
  }
}

/**
 * Stage, classify and commit.
 *
 * @returns {Promise<{ ok: boolean, hash?: string, subject?: string, error?: string, email?: string }>}
 */
async function doCommit(ctx, exec, options) {
  const settings = options.settings
  const root = options.root
  const message = options.message
  const entries = options.entries

  if (settings.autoAdd) {
    // `exec` is present for a tool call and absent for a `/git-commit-push` invocation
    // driven by tests or an embedding host, so the optional chain is required.
    //
    // AWAITED on purpose: this used to race the staged-numstat read below, so a
    // real commit reported `+0 / -0` on the card — a wrong number right where a
    // person looks for confirmation.
    await stageAll(root, exec?.signal)
  }

  const stagedStats = await numstat(root, true)
  // Guard the one setting that can make the commit itself impossible: with
  // autoAdd off, an empty index fails with git's own "nothing added to commit",
  // which reads like a plugin bug rather than a setting. When autoAdd is ON an
  // empty index is legitimate — a repository whose first commit has no `HEAD`
  // yet cannot produce a numstat at all — so the commit is attempted and git's
  // own answer is reported if there is truly nothing to commit.
  if (settings.autoAdd !== true && stagedStats.size === 0) {
    return {
      ok: false,
      error: '暂存区为空：autoAdd 已关闭且没有任何文件被暂存。请先 git add，或把配置里的 autoAdd 改回 true。',
    }
  }
  const { added, deleted } = totalsOf(stagedStats)

  try {
    await commit(root, message, settings.pinnedIdentity)
  } catch (error) {
    const text = brief(error)
    // A hook rejection is reported, never bypassed: `--no-verify` is not used
    // anywhere in this plugin.
    return { ok: false, error: text }
  }

  const hash = await headShort(root)
  return {
    ok: true,
    ...(hash === undefined ? {} : { hash }),
    subject: message.split('\n')[0],
    files: entries.length,
    added,
    deleted,
  }
}

/**
 * Create the tag and push branch + tag.
 *
 * The branch push and the tag push are separate commands so a tag rejection
 * (the common "tag already exists on the remote" case) leaves a successful
 * branch push fully verified instead of reported as an ambiguous single failure.
 *
 * @returns {Promise<{ pushed: boolean, tagCreated?: string, tagPushed?: boolean, note?: string, reason?: string }>}
 */
async function doTagAndPush(ctx, exec, options) {
  const { settings, root, branch, tag, upstream } = options
  const result = { pushed: false }
  // Notes accumulate; a later fact must never silently overwrite an earlier one.
  const notes = []
  const note = text => { notes.push(text) }

  if (tag !== undefined) {
    const invalid = await tagNameError(root, tag)
    if (invalid !== undefined) {
      note(`标签名无效（${invalid}），已跳过打标签`)
    } else if (await tagExists(root, tag)) {
      note(`标签 ${tag} 已存在，已跳过`)
    } else {
      try {
        await createTag(root, tag)
        result.tagCreated = tag
      } catch (error) {
        note(`创建标签失败：${brief(error)}`)
      }
    }
  }

  if (settings.autoPush !== true) {
    note('autoPush 已关闭，未推送')
    result.note = notes.join('；')
    return result
  }

  const pushed = await pushAfterRebase(root, branch, { hasUpstream: upstream })
  if (pushed.ok) {
    result.pushed = true
    if (pushed.rebased) note('远程有新提交，已 rebase 后重推')
    if (result.tagCreated !== undefined) {
      // The tag is a second command so its failure cannot be confused with the
      // branch push. A rejected tag push does NOT undo a successful push and is
      // reported as a note, not as a failed commit.
      const tagPush = await push(root, branch, { hasUpstream: true, tag: result.tagCreated })
      result.tagPushed = tagPush.ok
      if (!tagPush.ok) note(`分支已推送，但标签 ${result.tagCreated} 推送失败（${tagPush.reason ?? '未知原因'}）`)
    }
    result.note = notes.length > 0 ? notes.join('；') : undefined
    return result
  }

  result.reason = pushed.reason
  note(pushed.reason === 'rebase-conflict'
    ? '推送被拒且 rebase 出现冲突，已中止 rebase 并保留你的改动，需手动处理'
    : `推送失败（${pushed.reason ?? '未知原因'}）`)
  result.note = notes.join('；')
  return result
}

/**
 * Build the canonical value every action returns.
 *
 * `card` is part of the canonical value on purpose: `output.render` is a pure
 * projection of `(args, value)`, so it cannot derive a card that needs the
 * changeset and the push result unless the value carries it. Keeping it in the
 * value also means a PTC caller gets the same text a human sees.
 */
function valueOf(fields) {
  return {
    ok: fields.ok === true,
    // `action` is required by the output schema, and `run` is exported, so a
    // direct caller that omits it must still produce a schema-valid value.
    action: fields.action ?? 'auto',
    card: fields.card ?? '',
    ...(fields.root === undefined ? {} : { root: fields.root }),
    ...(fields.branch === undefined ? {} : { branch: fields.branch }),
    ...(fields.files === undefined ? {} : { files: fields.files }),
    ...(fields.changes === undefined ? {} : { changes: fields.changes }),
    ...(fields.hash === undefined ? {} : { hash: fields.hash }),
    ...(fields.draft === undefined ? {} : { draft: fields.draft }),
    ...(fields.tag === undefined ? {} : { tag: fields.tag }),
    ...(fields.tagCreated === undefined ? {} : { tagCreated: fields.tagCreated }),
    pushed: fields.pushed === true,
    ...(fields.note === undefined ? {} : { note: fields.note }),
    ...(fields.error === undefined ? {} : { error: fields.error }),
  }
}

/**
 * The compact markdown card for a survey.
 *
 * @param {object} surveyResult
 * @param {{ maxFilesShown: number }} settings
 */
function prepareCard(surveyResult, settings) {
  return renderCard({
    branch: surveyResult.branch,
    entries: surveyResult.entries,
    stats: surveyResult.stats,
    recentSubjects: surveyResult.recentSubjects,
    version: surveyResult.version,
    breaking: surveyResult.breaking,
    draft: surveyResult.draft,
    maxFiles: settings.maxFilesShown,
    hasUpstream: surveyResult.hasUpstream,
  })
}

/**
 * The compact markdown card for a completed commit.
 *
 * The first line is the VERDICT, not a label. A person who never expands the
 * card still learns whether the work landed and whether it was pushed — the
 * earlier `**git commit** · …` header was easy to mistake for a log line and
 * therefore for "nothing happened".
 *
 * Exported because the card contract (which verdict for which outcome) is worth
 * testing directly: the push-failure branch cannot be produced cheaply against
 * a real remote.
 *
 * Shape, in order: verdict line, one counts-only summary line, the commit
 * subject, the tag, the push outcome, and at most one note. It carries NO file
 * list and NO raw git output — the user asked for a result card, not a process
 * log, and the per-file notes are in the commit body where `git log` shows them.
 */
export function applyCard(options) {
  const {
    branch, hash, subject, tagCreated, pushed, pushedTag, note, surveyed, fileCount, totals, autoPush,
  } = options
  const lines = []
  const verdict = pushed
    ? '✅ **Git 提交并推送成功**'
    : autoPush === true
      ? '⚠️ **已提交，但推送失败**'
      : '✅ **Git 提交成功（未推送）**'
  lines.push(`${verdict} · \`${branch}\` · \`${hash ?? '?'}\``)

  // The one summary line a person reads: how many files were found changed, and
  // how many of them this commit carried. Deliberately COUNTS, not a file list —
  // the per-file notes live in the commit body, and a result card that opens
  // with a process log is exactly the noise this card replaced.
  const found = surveyed === undefined ? undefined : `检查到 ${surveyed} 个文件改动`
  const landed = fileCount === undefined
    ? undefined
    : `本次提交 ${fileCount} 个文件（+${totals?.added ?? 0} / -${totals?.deleted ?? 0}）`
  const summary = [found, landed].filter(part => part !== undefined).join('，')
  if (summary !== '') lines.push(summary)

  lines.push(`信息：${subject}`)
  lines.push(`标签：${tagCreated ?? '无'}`)
  lines.push(pushed
    ? `推送：已推送${pushedTag ? '（含标签）' : ''}`
    : autoPush === true ? '推送：失败（见下方说明）' : '推送：未推送')
  if (note !== undefined) lines.push(`说明：${note}`)
  return lines.join('\n')
}

/**
 * The single entry point behind both the tool and the `/git-commit-push` command.
 *
 * Settings are read here and passed down so that a settings file which exists
 * but does not parse can be REPORTED. Silently committing with the defaults
 * would leave a user staring at a config file that appears to do nothing.
 *
 * @param {object} ctx plugin context
 * @param {object} request
 * @param {string} request.action `prepare` | `apply` | `auto`
 * @param {string} [request.message] a caller-supplied commit message
 * @param {string} [request.tag] a caller-supplied tag name
 * @param {boolean} [request.push] override the autoPush setting
 * @param {'zh' | 'en'} [request.language]
 * @param {string} [request.cwd] explicit repository path
 * @param {object} [exec] tool run context (absent for the slash command)
 * @returns {Promise<ReturnType<typeof valueOf>>}
 */
export async function run(ctx, request, exec) {
  const { settings, problem } = await loadSettingsReport()
  const result = await runWithSettings(ctx, request, exec, settings)
  if (problem === undefined) return result
  return {
    ...result,
    card: `${result.card}\n配置未生效：${problem}`,
    note: result.note === undefined ? problem : `${result.note}；${problem}`,
  }
}

/**
 * Everything below `run` works on resolved settings.
 *
 * @param {object} ctx plugin context
 * @param {object} request
 * @param {object} [exec]
 * @param {typeof import('./lib/config.js').DEFAULTS} settings
 */
async function runWithSettings(ctx, request, exec, settings) {
  const cwd = request.cwd !== undefined && request.cwd !== '' ? request.cwd : cwdOf(exec)
  const language = request.language ?? settings.defaultLanguage
  const signal = exec?.signal

  // The plugin's own effective settings, after per-call overrides.
  const effective = { ...settings, autoPush: request.push ?? settings.autoPush }

  // Both `prepare` and `apply` start from the same survey: `apply` needs the
  // repo root, the branch and the tag evidence, and the calls it makes are
  // in-process reads that cost no tokens.
  const current = await survey({ cwd, language, maxFilesShown: effective.maxFilesShown })

  if (current.ok !== true) {
    if (current.notRepo === true) {
      const candidates = current.candidates ?? []
      const card = candidates.length === 0
        ? '❌ **未初始化 Git**（该项目不是 Git 仓库，未做任何提交）'
        : [
          '⚠️ **当前目录不是 Git 仓库**；其下有这些仓库，请用 cwd 参数指定：',
          ...candidates.map(root => `  - ${root}`),
        ].join('\n')
      return valueOf({
        ok: false,
        action: request.action,
        card,
        error: candidates.length === 0 ? 'not-a-repository' : 'ambiguous-repository',
        note: candidates.length === 0 ? undefined : '传入 cwd 指向具体仓库后重试',
      })
    }
    return valueOf({
      ok: false,
      action: request.action,
      card: current.reason === 'clean'
        ? 'ℹ️ **没有需要提交的改动**（工作区是干净的）'
        : `⚠️ **无法读取仓库状态**：${current.message ?? '未知原因'}`,
      error: current.reason ?? 'survey-failed',
    })
  }

  if (request.action === 'prepare') {
    return valueOf({
      ok: true,
      action: 'prepare',
      card: prepareCard(current, effective),
      root: current.root,
      branch: current.branch,
      files: current.entries.length,
      changes: current.entries.map(entry => ({ status: entry.status, path: entry.path })),
      draft: current.draft.message,
    })
  }

  // Who writes the body? A caller-supplied message is honored, but when it is a
  // bare subject (no body of its own) the per-file notes are appended rather
  // than replaced: "one message for every file" is exactly what the body is
  // there to avoid, and the caller usually only has an opinion about the sum.
  const supplied = request.message !== undefined && request.message !== ''
  const generated = current.draft.message
  let message = supplied ? request.message : generated
  if (supplied && !request.message.includes('\n') && current.entries.length > 1) {
    const body = generated.split('\n').slice(1).join('\n').replace(/^\n+/u, '')
    if (body !== '') message = `${request.message}\n\n${body}`
  }

  let committed
  try {
    committed = await doCommit(ctx, exec, {
      settings: effective,
      root: current.root,
      message,
      entries: current.entries,
    })
  } catch (error) {
    // `stageAll` and the numstat read can fail outside the commit itself
    // (a locked index, a path the filesystem refuses). Report it as a card
    // rather than letting the registry surface a raw throw.
    committed = { ok: false, error: brief(error) }
  }

  if (committed.ok !== true) {
    return valueOf({
      ok: false,
      action: request.action,
      card: `❌ **提交失败**（改动仍留在工作区，未推送）\n原因：${committed.error ?? '未知原因'}`,
      root: current.root,
      branch: current.branch,
      error: 'commit-failed',
      note: committed.error,
    })
  }

  const decision = tagDecision(current, effective, request.tag)
  let tagResult
  if (request.tag !== undefined) {
    // An EXPLICIT tag is an instruction, not a suggestion, so it skips the
    // question entirely. Routing it through askTag would let a missing asker —
    // a subagent, a host without the question service, a timed-out wait, or a
    // plain `run()` call — silently drop a tag the caller explicitly asked for.
    tagResult = { decided: request.tag, via: 'explicit' }
  } else if (decision.shouldAsk) {
    tagResult = await askTag(ctx, exec, decision.tag, decision.reasons, effective)
  } else {
    tagResult = { decided: undefined, via: 'skipped' }
  }

  const pushResult = await doTagAndPush(ctx, exec, {
    settings: effective,
    root: current.root,
    branch: current.branch,
    tag: tagResult.decided,
    upstream: current.hasUpstream,
  })

  const notes = [tagResult.note, pushResult.note].filter(note => typeof note === 'string' && note !== '')

  // `ok` answers "did the thing the caller asked for happen", and the commit is
  // the thing that was asked for: it landed, so this is a success even when the
  // push did not. The push outcome is NOT hidden — `pushed` is false, the card
  // says so, and `error` carries the machine-branchable reason — but reporting
  // `ok: false` here would make `/git-commit-push` fail on a commit that is safely in the
  // repository, which is worse than useless.
  const pushFailed = effective.autoPush === true && !pushResult.pushed

  return valueOf({
    ok: true,
    action: request.action,
    card: applyCard({
      branch: current.branch,
      hash: committed.hash,
      subject: committed.subject ?? message,
      tagCreated: pushResult.tagCreated,
      pushed: pushResult.pushed,
      pushedTag: pushResult.tagPushed,
      note: notes.length > 0 ? notes.join('；') : undefined,
      surveyed: current.entries.length,
      fileCount: committed.files,
      totals: { added: committed.added ?? 0, deleted: committed.deleted ?? 0 },
      autoPush: effective.autoPush,
    }),
    root: current.root,
    branch: current.branch,
    files: committed.files,
    hash: committed.hash,
    tag: pushResult.tagCreated ?? tagResult.decided,
    tagCreated: pushResult.tagCreated,
    pushed: pushResult.pushed,
    note: notes.length > 0 ? notes.join('；') : undefined,
    error: pushFailed ? pushResult.reason ?? 'push-failed' : undefined,
  })
}

/** The `render` projection: model-facing content is exactly the card. */
function renderCardContent(_args, value) {
  const text = value?.card !== undefined && value.card !== '' ? value.card : (value?.error ?? 'no result')
  return [{ type: 'text', text }]
}

/**
 * A hand-written tool definition, in the RAW JSON Schema form.
 *
 * This is deliberate, and it is the one place where being explicit matters most:
 *
 *   - `parameters` is the enforced JSON Schema subset (`JsonSchemaNode`), NOT the
 *     `ParameterSchemaSpec` authoring DSL. The DSL's per-property
 *     `required: true` is compiled by `defineTool` and by nothing else, so a
 *     hand-written definition must carry a real object root with a
 *     `required: string[]` array — otherwise the model receives a bare property
 *     map with no `type: 'object'`, which providers reject.
 *   - `output.schema` is validated by the registry at REGISTRATION time, and a
 *     `required` that is not an array of strings throws a JsonSchemaError there,
 *     taking the whole plugin down before either entry point registers.
 *   - `output.render` must be a pure projection of `(args, value)`, which is why
 *     the human-readable card travels INSIDE the canonical value.
 */
const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Commit the current repository and (by default) push it, in one call. '
    // The trigger rule comes FIRST and is deliberately blunt: this tool creates
    // an outward-facing repository change, so it must never be reached for by
    // inference from "the work looks finished".
    + 'CALL THIS ONLY WHEN THE USER ASKS FOR IT — either they asked you in words to commit and/or push '
    + '(「提交」「commit」「推送」「push」「推上去」), or they typed the `/git-commit-push` slash command. '
    + 'NEVER call it on your own initiative: not because you or the user just finished editing files, not because a '
    + 'task looks complete, not because the session is ending, and not as a tidy-up step. Editing files is not a '
    + 'request to commit them. If it is unclear whether the user wants a commit, ask first. '
    + 'action="auto" commits immediately using the rule-generated message — ONE call, no second turn. Prefer it when '
    + 'the user simply wants the work committed and pushed and has no opinion about the wording; it is what the '
    + '`/git-commit-push` slash command uses. '
    + 'action="prepare" is the brief survey to use ONLY when the user wants to choose the message or review the '
    + 'changeset first: verdict line, file list with per-file line '
    + 'counts, each file\'s own Conventional-Commits note, status counts, recent commit subjects for tone, and a '
    + 'rule-generated draft message — WITHOUT spending tokens on the diff itself. Read it, write your own '
    + 'Conventional-Commits subject, then call action="apply" with that subject as `message`. '
    + 'MULTI-FILE COMMITS GET ONE NOTE PER FILE: when several files changed, the commit body lists each file with its '
    + 'own typed note (`- fix(api): correct retry decision · src/api/retry.ts`), and the notes are generated per file '
    + 'even when you supply only a subject — supplying a message with a body of your own replaces them entirely. '
    + 'WHEN IT IS DONE, REPORT THE CARD, NOT THE PROCESS: the returned card opens with the verdict line and carries a '
    + 'counts-only summary, and that card is the whole user-facing report. Do not narrate the steps you took, do not '
    + 'restate the file list, and do not paste raw git output into the conversation. '
    + 'The plugin stages the working tree, commits, asks the user about a tag when a version bump, a possible '
    + 'breaking change or a large changeset warrants one (the question is answered in the UI and costs no tokens), '
    + 'and pushes, retrying once through `pull --rebase` if the remote moved. '
    + 'It never modifies .gitignore or git config, never force-pushes, and never bypasses a failing hook. '
    + 'In a directory that is not a repository it reports the child repositories instead of guessing.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {
      action: {
        type: 'string',
        enum: ['prepare', 'apply', 'auto'],
        description: 'prepare: survey only. apply: commit with `message`. auto: survey and commit with the rule-generated message.',
      },
      message: {
        type: 'string',
        description: 'The commit message, in Conventional Commits form. Implies action="apply" when action is omitted. '
          + 'The first line is the subject; later lines become the body and REPLACE the per-file notes the plugin would '
          + 'generate. Supply only a subject and the per-file notes are still appended for you.',
      },
      tag: {
        type: 'string',
        description: 'Explicit tag name to create and push (e.g. "v1.2.3"). Skips the tag question. Omit to let the plugin decide.',
      },
      push: {
        type: 'boolean',
        description: 'Override the autoPush setting for this call only.',
      },
      language: {
        type: 'string',
        enum: ['zh', 'en'],
        description: 'Language for the rule-generated message (default: the plugin setting, normally zh).',
      },
      cwd: {
        type: 'string',
        description: 'Path of the repository to operate on. Use it when the session working directory is a container '
          + 'holding several repositories.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'action', 'card', 'pushed'],
      properties: {
        ok: { type: 'boolean', description: 'Whether the work the caller asked for actually happened.' },
        action: { type: 'string', description: 'The action that ran: prepare | apply | auto.' },
        card: { type: 'string', description: 'The compact human-readable report for this call.' },
        root: { type: 'string', description: 'Absolute path of the repository that was operated on.' },
        branch: { type: 'string', description: 'Branch the commit landed on.' },
        files: { type: 'number', description: 'Number of changed (prepare) or committed (apply/auto) files.' },
        changes: {
          type: 'array',
          description: 'prepare only: one row per changed path.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'path'],
            properties: {
              status: { type: 'string', description: 'A (added) | M (modified) | D (deleted) | R (renamed) | C (copied) | U (unmerged) | ? (untracked).' },
              path: { type: 'string', description: 'Repository-relative path.' },
            },
          },
        },
        hash: { type: 'string', description: 'Short hash of the created commit.' },
        draft: { type: 'string', description: 'prepare only: the rule-generated Conventional Commits message.' },
        tag: { type: 'string', description: 'Tag that was created, or the one that was suggested.' },
        tagCreated: { type: 'string', description: 'Tag actually created locally, when one was.' },
        pushed: { type: 'boolean', description: 'Whether the branch reached the remote.' },
        note: { type: 'string', description: 'Anything the caller must know: a rebase recovery, a skipped tag, a hook rejection.' },
        error: { type: 'string', description: 'Machine-branchable failure code when something the caller asked for did not happen.' },
      },
    },
    render: renderCardContent,
  },
  /**
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal, agent?: unknown, callId?: unknown }} exec
   */
  async execute(args, exec) {
    const action = typeof args.action === 'string'
      ? args.action
      : (typeof args.message === 'string' && args.message !== '' ? 'apply' : 'prepare')
    return run(PLUGIN_CONTEXT, {
      action,
      message: typeof args.message === 'string' ? args.message : undefined,
      tag: typeof args.tag === 'string' ? args.tag : undefined,
      push: typeof args.push === 'boolean' ? args.push : undefined,
      language: args.language === 'zh' || args.language === 'en' ? args.language : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    }, exec)
  },
}

/**
 * The plugin's own context, captured in `apply` so the hand-written tool
 * definition can reach `ctx.get('userQuestions')` without importing
 * `defineTool` (and therefore without depending on the host's module
 * resolution reaching this package's own imports).
 */
let PLUGIN_CONTEXT

/** Parse the `/git-commit-push` command line into a request. */
export function parseCommitCommand(rawInput) {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  const request = { action: 'auto' }
  const messageParts = []
  for (const token of tokens) {
    if (token === '--auto') { request.action = 'auto'; continue }
    if (token === '--prepare' || token === '--dry-run') { request.action = 'prepare'; continue }
    if (token === '--no-push') { request.push = false; continue }
    if (token === '--push') { request.push = true; continue }
    if (token === '--en') { request.language = 'en'; continue }
    if (token === '--zh') { request.language = 'zh'; continue }
    if (token.startsWith('--tag=')) { request.tag = token.slice('--tag='.length); continue }
    if (token.startsWith('--cwd=')) { request.cwd = token.slice('--cwd='.length); continue }
    messageParts.push(token)
  }
  const message = messageParts.join(' ').trim()
  if (message !== '') {
    request.message = message
    // An explicit message with no explicit verb means "commit this".
    if (!tokens.includes('--prepare') && !tokens.includes('--dry-run')) request.action = 'apply'
  }
  return request
}

/**
 * Register the slash command once the commands service is available.
 *
 * `commands` is a strictly optional capability, so it is deliberately NOT in
 * the static `inject` list: putting it there would block the whole plugin (and
 * therefore the `git_commit_push` tool) on a host that has no command surface. The
 * scoped `ctx.inject` waits for it in the background instead, and the tool works
 * either way. `commands` is the common case — this profile mounts it.
 */
function registerCommand(ctx) {
  ctx.inject(['commands'], (sctx) => {
    const commands = sctx.get('commands')
    if (commands === undefined) return
    commands.register({
      name: COMMAND_NAME,
      description: '提交并推送当前项目（Conventional Commits），可用 --prepare 仅预览、--no-push 不推送',
      input: { hint: '[提交信息 | --prepare | --en | --no-push | --tag=vX.Y.Z]' },
      handler: async (invocation) => {
        const request = parseCommitCommand(invocation.rawInput ?? '')
        const exec = { signal: invocation.signal, agent: invocation.agent, callId: invocation.commandId }
        try {
          const result = await run(ctx, request, exec)
          if (result.ok) return { kind: 'success', text: result.card }
          return { kind: 'error', text: result.card !== '' ? result.card : '提交未完成' }
        } catch (error) {
          return { kind: 'error', text: brief(error) }
        }
      },
    })
  })
}

/**
 * Register the skill this package ships (SKILL.md) as an embedded runtime skill.
 *
 * `skills` is an optional capability exactly like `commands`, so it is not in
 * the static `inject` list: a host without a skill registry must still get the
 * tool. The registry draws the ordering — a project-level skill with the same
 * name outranks this runtime registration, so a user who keeps their own
 * `git-commit-push` skill in the workspace keeps winning.
 *
 * A registration failure is logged, never thrown: losing the skill costs the
 * model its procedure, losing the tool costs the user the feature.
 */
function registerSkill(ctx) {
  ctx.inject(['skills'], (sctx) => {
    const skills = sctx.get('skills')
    if (skills === undefined) return
    const skill = skillDefinition()
    if (skill === undefined) {
      ctx.logger?.warn?.(`${name}: SKILL.md is missing or unusable; the git-commit-push skill was not registered`)
      return
    }
    try {
      skills.register(skill)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: skill "${skill.name}" was not registered — ${brief(error)}`)
    }
  })
}

/**
 * Re-implementation of the registry's schema assertions, so a test can prove
 * the definition would survive `ctx.tools.register` WITHOUT needing a live host.
 *
 * The two rules that actually bite a hand-written definition:
 *   - `required` must be an ARRAY OF STRINGS. The `required: true` per-property
 *     form belongs to the `defineTool` authoring DSL and is rejected here, at
 *     registration time, with a JsonSchemaError that takes the plugin down.
 *   - every node's `type` must be one of the supported scalars/containers, and
 *     `enum`/`const` are only valid on scalars.
 *
 * @returns {string[]} violations; empty means registration would succeed
 */
export function schemaProblems(schema, path = 'schema') {
  const SUPPORTED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const problems = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} must be a plain object`]
  }
  if (schema.type !== undefined && !SUPPORTED_TYPES.includes(schema.type)) {
    problems.push(`${path}.type "${String(schema.type)}" is not supported`)
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(entry => typeof entry !== 'string')) {
      // The exact failure mode this guards: `required: true` from the DSL.
      problems.push(`${path}.required must be an array of strings`)
    } else if (schema.properties !== undefined) {
      for (const name of schema.required) {
        if (!(name in schema.properties)) problems.push(`${path}.required names "${name}", which is not declared`)
      }
    }
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    problems.push(...schemaProblems(child, `${path}.properties.${name}`))
  }
  if (schema.items !== undefined) problems.push(...schemaProblems(schema.items, `${path}.items`))
  for (const [index, branch] of (schema.oneOf ?? []).entries()) {
    problems.push(...schemaProblems(branch, `${path}.oneOf[${String(index)}]`))
  }
  return problems
}

/** Everything the registry would reject about this tool definition. */
export function toolDefinitionProblems() {
  const problems = []
  if (typeof TOOL_DEFINITION.name !== 'string' || TOOL_DEFINITION.name === '') problems.push('name is missing')
  if (typeof TOOL_DEFINITION.description !== 'string' || TOOL_DEFINITION.description === '') problems.push('description is missing')
  if (typeof TOOL_DEFINITION.output?.render !== 'function') problems.push('output.render is missing')
  problems.push(...schemaProblems(TOOL_DEFINITION.parameters, 'parameters'))
  if (TOOL_DEFINITION.output?.schema === undefined) problems.push('output.schema is missing')
  else problems.push(...schemaProblems(TOOL_DEFINITION.output.schema, 'output.schema'))
  return problems
}

/**
 * Plugin entry point.
 *
 * @param {any} ctx host plugin context
 */
export function apply(ctx) {
  PLUGIN_CONTEXT = ctx
  // Fail loudly and specifically here rather than with an opaque registry error:
  // a malformed definition is an authoring bug the host reports once, at boot.
  const problems = toolDefinitionProblems()
  if (problems.length > 0) {
    throw new Error(`${name}: invalid tool definition — ${problems.join('; ')}`)
  }
  ctx.tools.register(TOOL_DEFINITION)
  registerCommand(ctx)
  registerSkill(ctx)
}

/** Diagnostics: the settings files this plugin reads, and the self-check hooks. */
export { CONFIG_PATH, userConfigPath, configCandidates, TOOL_DEFINITION }
export { FIELDS as SETTINGS_FIELDS, IDENTITY_FIELDS } from './lib/config.js'
export { skillDefinition, parseSkillFile, SKILL_NAME, SKILL_PATH, SKILL_SOURCE } from './lib/skill.js'
export { survey } from './lib/survey.js'
export { push, pushAfterRebase } from './lib/git.js'
