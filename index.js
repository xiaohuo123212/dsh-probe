// dsh-probe — 临时探针工作台（DSH 插件）。
//
// 设计约束与 dsh-perf-opt 相同：这个 bundle 会被 link 进 profile 目录，
// 只允许 node: 内置模块，不 import 任何 Harness 包；工具定义用普通 JSON Schema。
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, PLUGIN_DIR, loadOptions, numberIn, oneOf, requireText, resolveCwd, resolvePaths } from './lib/project.js'
import {
  dropBaseline, ensureSession, loadBaseline, loadSession, makeSessionId, nextRunId, saveSession, sessionDigest,
} from './lib/store.js'
import { ensureDir, jsonSafe, nowIso, readJson, readText, tailText, writeText } from './lib/util.js'
import { findMarkers, stripMarkers } from './lib/markers.js'
import { insertProbe } from './lib/insert.js'
import { runCommand, runScript, writeRunRecord } from './lib/runner.js'
import { createScript, listScripts, removeScript, showScript } from './lib/scripts.js'
import { GUARD_SKIP_NOTE, guardScan, residualScan } from './lib/guard.js'
import { appendLedger, ledgerSummary, listLedger } from './lib/report.js'
import { guide } from './lib/guide.js'

export const name = 'probe'
export const inject = ['tools']

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
  },
  required: ['summary'],
  additionalProperties: false,
}

const COMMAND_SCHEMA = {
  oneOf: [
    { type: 'string', description: 'Command line executed through the platform shell. Quote carefully.' },
    { type: 'array', items: { type: 'string' }, description: 'argv array executed directly (preferred: no shell quoting).' },
  ],
}

const CWD_SCHEMA = {
  type: 'string',
  description: 'Project directory. Defaults to the session working directory.',
}

const VERDICTS = ['explained', 'refuted', 'inconclusive']
const RUNTIMES = ['node', 'python', 'powershell', 'auto']
const GUIDE_SECTIONS = ['workflow', 'markers', 'scripts', 'run', 'clean', 'guard', 'pitfalls', 'languages', 'all']

function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    timeoutMs: definition.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const value = await definition.run(args ?? {}, exec ?? {})
      if (value.result === undefined) return { summary: value.summary }
      return { summary: value.summary, result: jsonSafe(value.result) }
    },
  }
}

/**
 * 惰性初始化：第一次在某个工作区用 probe_* 就自动开店，不需要先跑 probe_begin。
 * 返回 created=true 时，调用方负责在 summary 里说一句「自动开了会话」。
 */
function ensureActive(cwd, options) {
  return ensureSession(cwd, options)
}

function autoNote(session, created) {
  return created
    ? `- 首次在此工作区使用，已自动初始化探针会话 ${session.id}${session.label ? `（label="${session.label}"）` : ''}。`
      + '想记下「这次要弄清什么」，用 probe_begin goal="..."（会收编这个会话，不会重开）。'
    : null
}

export function apply(ctx, config = {}) {
  const pluginConfig = config ?? {}
  if (globalThis.process?.env?.DSH_PROBE_DEBUG === '1') {
    globalThis.process.stderr.write('[probe] activated: 9 tools + runtime skill\n')
  }

  async function contextFor(args, exec) {
    const cwd = resolveCwd(ctx, exec, args)
    const options = await loadOptions(cwd, pluginConfig)
    return { cwd, options, paths: resolvePaths(cwd, options) }
  }

  // ── 1. probe_begin ────────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_begin',
    timeoutMs: 60000,
    description:
      'Record what you are trying to find out for the CURRENT probe session, and open one if no session exists. '
      + 'You do NOT have to call this first: any probe_* tool lazily initialises .probe/ on first use in a '
      + 'workspace. Calling probe_begin on a freshly auto-created, still-empty session adopts it (same id) and '
      + 'just fills in the goal; calling it on a session that already has probes/scripts/runs is refused unless '
      + 'reset=true, because those probes are still sitting in the files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        label: { type: 'string', description: 'Short name for this probe round, e.g. "stale-cache-repro".' },
        goal: { type: 'string', description: 'One sentence: what do you want to find out? This is the question the ledger will record.' },
        reset: { type: 'boolean', description: 'Replace an existing session even if its probes were never cleaned (dangerous: those probes stay in the files).' },
      },
      required: ['goal'],
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const goal = requireText(args.goal, 'goal')
      const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : undefined
      const previous = loadSession(cwd, options)
      const live = previous && !previous.cleanedAt ? previous : null
      const busy = live ? (live.probes ?? []).length + (live.scripts ?? []).length + (live.runs ?? []).length : 0

      // 收编现有会话：只补 goal/label，不重开。重开必须显式 reset=true（旧探针不会被拆）。
      if (live && args.reset !== true) {
        live.goal = goal
        if (label) live.label = label
        live.autoStarted = false
        saveSession(cwd, live, options)
        const lines = [
          `已把目标写进会话 ${live.id}${live.label ? `（${live.label}）` : ''}`,
          `- 目标：${goal}`,
          `- 状态文件：${sessionRel(cwd, paths.sessionFile)}`,
        ]
        if (busy > 0) {
          const files = [...new Set((live.probes ?? []).map((probe) => probe.file))]
          lines.push(`- 注意：这个会话已经动了东西（${(live.probes ?? []).length} 个探针/`
            + `${(live.scripts ?? []).length} 个脚本/${(live.runs ?? []).length} 条运行记录，文件：${files.join(', ') || '无'}）。`
            + '换一轮新会话要带 reset=true（旧探针不会被替你拆掉）。')
        }
        lines.push('- 下一步：probe_insert 插源码探针，或 probe_script 建临时脚本，然后 probe_run 跑一次。')
        return { summary: lines.join('\n'), result: { ...sessionDigest(cwd, live), adopted: true } }
      }

      const session = {
        version: 1,
        id: makeSessionId(),
        label,
        goal,
        startedAt: nowIso(),
        cwd: cwd.split(path.sep).join('/'),
        baseline: {},
        probes: [],
        scripts: [],
        runs: [],
      }
      for (const dir of [paths.dir, paths.baselineDir, paths.scriptsDir, paths.runsDir, paths.tmpDir]) ensureDir(dir)
      saveSession(cwd, session, options)
      const lines = [
        `探针会话已开：${session.id}${session.label ? `（${session.label}）` : ''}`,
        `- 目标：${goal}`,
        `- 状态文件：${sessionRel(cwd, paths.sessionFile)}`,
        '- 下一步：probe_insert 插源码探针，或 probe_script 建临时脚本，然后 probe_run 跑一次。',
        '- 收尾必须 probe_clean，再用 probe_guard 确认没有一个标记漏进提交。',
      ]
      if ((previous?.probes ?? []).length > 0) {
        lines.push(`- 注意：上一个会话的 ${previous.probes.length} 个探针仍留在文件里（reset 不会替你拆）。`)
      }
      return { summary: lines.join('\n'), result: sessionDigest(cwd, session) }
    },
  }))

  // ── 2. probe_status ──────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_status',
    timeoutMs: 30000,
    description:
      'Show the live state of the probe session: the question, every probe still hanging (file and line range), '
      + 'the temporary scripts, the runs so far, and whether the recorded probes are still present in the files. '
      + 'Use it before inserting the next probe (more than ~10 probes means the question is wrong) and before '
      + 'cleaning up, so you know exactly what will be removed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { cwd: CWD_SCHEMA },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const session = loadSession(cwd, options)
      if (!session) {
        return { summary: '这个工作区还没有探针会话。任意 probe_* 首次调用会自动初始化；也可以用 probe_begin goal="..." 显式开一次。', result: { active: false } }
      }
      const probes = session.probes ?? []
      const byFile = new Map()
      for (const probe of probes) {
        if (!byFile.has(probe.file)) byFile.set(probe.file, [])
        byFile.get(probe.file).push(probe)
      }
      // 记录说在、文件里没有 = 被手工删过；文件里有、记录没有 = 手工插的。两种都值得点名。
      const drift = []
      for (const [file, items] of byFile) {
        const text = readText(path.resolve(cwd, file))
        if (text === null) {
          drift.push(`${file}：文件已不存在`)
          continue
        }
        const present = new Set(findMarkers(text).map((marker) => marker.id))
        const recorded = new Set(items.map((probe) => probe.id))
        for (const id of recorded) if (!present.has(id)) drift.push(`${file}:${id} 记录里有、文件里找不到（被手工删了？）`)
        for (const id of present) if (!recorded.has(id)) drift.push(`${file}:${id} 文件里有、会话没记录（手工插的？probe_clean scanAll=true 可清）`)
      }
      const ledger = readJson(paths.ledgerJson, [])
      const scripts = session.scripts ?? []
      const runs = session.runs ?? []
      const lines = [
        `会话 ${session.id}${session.label ? `（${session.label}）` : ''} · ${session.cleanedAt ? '已 clean' : '进行中'}`,
        `- 目标：${session.goal ?? '（未记录）'}`,
        `- 开始：${session.startedAt ?? '?'}`,
        `- 探针 ${probes.length} 个 / 文件 ${byFile.size} 个${probes.length > 10 ? ' · 警告：超过 10 个，先回头看看 goal 对不对' : ''}`,
      ]
      for (const [file, items] of byFile) {
        lines.push(`  · ${file}：${items.map((probe) => `${probe.id}(${probe.startLine}-${probe.endLine})`).join(' ')}`)
      }
      if (drift.length > 0) {
        lines.push(`- 记录与文件不一致 ${drift.length} 处：`)
        for (const item of drift.slice(0, 10)) lines.push(`  · ${item}`)
        if (drift.length > 10) lines.push(`  · …（还有 ${drift.length - 10} 处）`)
      }
      lines.push(`- 临时脚本 ${scripts.length} 个${scripts.length > 0 ? `（${scripts.map((s) => s.name).join(', ')}）` : ''}`)
      lines.push(`- 运行记录 ${runs.length} 条${runs.length > 0 ? `（最近 ${runs[runs.length - 1].id}：${runs[runs.length - 1].command}）` : ''}`)
      lines.push(`- 账本 ${Array.isArray(ledger) ? ledger.length : 0} 条（PROBE.md）`)
      lines.push(probes.length > 0 ? '- 下一步：probe_run 跑一次，或 probe_clean 拆掉。' : '- 下一步：probe_insert 插一个，或 probe_clean 收尾。')
      return {
        summary: lines.join('\n'),
        result: { session: sessionDigest(cwd, session), drift, probes, scripts, runs },
      }
    },
  }))

  // ── 3. probe_insert ──────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_insert',
    timeoutMs: 120000,
    description:
      'Insert a temporary instrumentation block into a source file, wrapped in greppable dsh-probe markers, '
      + 'and record the original file as a baseline. Location by unique `anchor` substring or explicit 1-based '
      + '`line`; indentation follows the anchor by default. Nothing is written when the anchor is ambiguous or '
      + 'the request is invalid. Remove later with probe_clean, which restores the file byte-for-byte.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        file: { type: 'string', description: 'Source file, relative to cwd (or absolute, but inside cwd).' },
        code: { type: 'string', description: 'Code to insert, e.g. `console.log("[probe]", JSON.stringify(state))`. Multiple lines allowed.' },
        anchor: { type: 'string', description: 'Substring that occurs exactly once; the block goes after that line.' },
        line: { type: 'integer', description: '1-based line number instead of anchor.' },
        position: { type: 'string', enum: ['after', 'before'], description: 'With line: insert after (default) or before that line.' },
        label: { type: 'string', description: 'Short tag written into the marker, e.g. "len" or "dt".' },
        indent: { type: 'string', description: '"anchor" (default, follow the anchor line), "none", or a literal prefix.' },
        create: { type: 'boolean', description: 'Create the file if it does not exist (appends at the end when no anchor/line is given).' },
      },
      required: ['file', 'code'],
    },
    async run(args, exec) {
      const { cwd, options } = await contextFor(args, exec)
      const { session, created } = ensureActive(cwd, options)
      const outcome = await insertProbe({
        cwd,
        session,
        file: requireText(args.file, 'file'),
        code: requireText(args.code, 'code'),
        anchor: args.anchor,
        line: args.line,
        position: args.position,
        label: args.label,
        indent: args.indent,
        create: args.create === true,
      })
      saveSession(cwd, session, options)
      const probe = outcome.probe
      const lines = [
        `已插入 ${probe.id} → ${probe.file}:${probe.startLine}-${probe.endLine}`,
        `- 标记：>>> dsh-probe begin ${probe.id}${probe.label ? ` ${probe.label}` : ''} … <<< dsh-probe end ${probe.id}`,
        `- 基线已存：${baselineRel(cwd, options, probe.file)}（clean 时用来核对是否逐字节还原）`,
        '- 下一步：probe_run command=[...] 跑一次；探针请用 console.log("[probe]", ...) 输出。',
        '- 收尾：probe_clean（会原样拆掉这一块）。',
      ]
      const note = autoNote(session, created)
      if (note) lines.push(note)
      return { summary: lines.join('\n'), result: { file: probe.file, probe } }
    },
  }))

  // ── 4. probe_script ──────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_script',
    timeoutMs: 60000,
    description:
      'Manage throwaway verification scripts under .probe/scripts/: scaffold one from a working template '
      + '(node / python / powershell, with argument parsing and the [probe] output convention), list them, '
      + 'show one, or delete one. These are transient by design — probe_clean removes them — so you never '
      + 'have to remember where the scratch files went.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        action: { type: 'string', enum: ['new', 'list', 'show', 'rm'], description: 'Default list.' },
        name: { type: 'string', description: 'Script name without extension, e.g. "repro-cache".' },
        runtime: { type: 'string', enum: RUNTIMES, description: 'new: node (default), python, powershell, or auto by name suffix.' },
        body: { type: 'string', description: 'new: full script body. Omit for the template.' },
        force: { type: 'boolean', description: 'new: overwrite an existing script (the old one is backed up under .probe/tmp/).' },
      },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const action = oneOf(args.action, ['new', 'list', 'show', 'rm'], 'list', 'action')
      const readOnly = action === 'list' || action === 'show'
      // 只读的 list/show 不该为了看一眼而建目录；new/rm 才惰性初始化。
      const { session, created } = readOnly
        ? { session: loadSession(cwd, options) ?? { probes: [], scripts: [], runs: [], baseline: {} }, created: false }
        : ensureActive(cwd, options)
      if (action === 'new') {
        const name = requireText(args.name, 'name')
        const runtime = oneOf(args.runtime, RUNTIMES, 'node', 'runtime')
        const outcome = await createScript({ cwd, session, paths, name, runtime, body: args.body, force: args.force === true })
        saveSession(cwd, session, options)
        return {
          summary: [
            `${outcome.created ? '已创建' : '已覆盖'}探针脚本：${outcome.script.name}（${outcome.script.runtime}）`,
            `- 文件：${outcome.file}`,
            `- 跑法：probe_run script="${outcome.script.name}" args=["--foo","1"]`,
            '- 输出约定：每行以 [probe] 开头才会被 probe_run 抽进 probeLines。',
            ...(autoNote(session, created) ? [autoNote(session, created)] : []),
          ].join('\n'),
          result: outcome,
        }
      }
      if (action === 'list') {
        const items = listScripts({ cwd, session, paths })
        const summary = items.length === 0
          ? '还没有临时探针脚本。probe_script action=new name=repro 建一个。'
          : ['临时探针脚本：', ...items.map((s) => `- ${s.name}（${s.runtime}，${s.bytes}B${s.markers ? '，含标记' : ''}）→ ${s.file}`)].join('\n')
        return { summary, result: { items } }
      }
      if (action === 'show') {
        const found = showScript({ cwd, session, paths, name: requireText(args.name, 'name') })
        return { summary: `# ${found.name}（${found.runtime}）${found.file}\n\n${found.text}`, result: found }
      }
      const removed = removeScript({ cwd, session, paths, name: requireText(args.name, 'name') })
      saveSession(cwd, session, options)
      return { summary: `已删除探针脚本 ${removed.name}（${removed.file}）`, result: removed }
    },
  }))

  // ── 5. probe_run ─────────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_run',
    timeoutMs: 1800000,
    description:
      'Run one command or one registered probe script with the probes currently in place, and collect the '
      + 'result: exit code, wall time, a run record under .probe/runs/, and every output line that starts '
      + 'with [probe]. A non-zero exit code is data, not an error. Pass argv arrays to avoid shell quoting. '
      + 'This is the measurement half of the loop: edit → probe_run → read → edit again, no scaffolding.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        command: COMMAND_SCHEMA,
        script: { type: 'string', description: 'Registered probe script name (probe_script action=new).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the script.' },
        timeoutSec: { type: 'integer', description: `Seconds before the process tree is killed (default ${DEFAULTS.defaultTimeoutSec}).` },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables.' },
        collect: { type: 'boolean', description: 'Collect [probe] lines (default true).' },
        label: { type: 'string', description: 'Short label used in the run record filename.' },
      },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const { session, created } = ensureActive(cwd, options)
      const timeoutSec = numberIn(args.timeoutSec, options.defaultTimeoutSec, 1, 86400)
      const collect = args.collect !== false
      let outcome
      let commandText
      if (typeof args.script === 'string' && args.script.trim() !== '') {
        const name = args.script.trim()
        outcome = await runScript({ cwd, session, name, args: Array.isArray(args.args) ? args.args : [], timeoutSec, signal: exec?.signal })
        const entry = (session.scripts ?? []).find((script) => script.name === name)
        commandText = `probe_script:${name}${entry ? ` (${entry.file})` : ''}`
      } else {
        if (args.command === undefined) throw new Error('probe_run 需要 command 或 script 之一')
        outcome = await runCommand({
          cwd,
          command: args.command,
          timeoutSec,
          env: args.env,
          collect,
          signal: exec?.signal,
        })
        commandText = Array.isArray(args.command) ? args.command.join(' ') : String(args.command)
      }
      const run = {
        id: nextRunId(session),
        label: typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : undefined,
        command: commandText,
        exitCode: outcome.exitCode,
        signal: outcome.signal ?? null,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut === true,
        truncated: outcome.truncated === true,
        probeLines: collect ? outcome.probeLines ?? [] : [],
        createdAt: nowIso(),
      }
      run.recordFile = writeRunRecord(paths, session, { ...run, stdout: outcome.stdout, stderr: outcome.stderr })
      // writeRunRecord 内部已经把条目（含 recordFile、按 maxRuns 裁剪）写进 session.runs，这里不能再 push 一次。
      saveSession(cwd, session, options)

      const head = outcome.timedOut
        ? `超时（${timeoutSec}s）已被杀掉`
        : `退出码 ${outcome.exitCode}${outcome.signal ? `（信号 ${outcome.signal}）` : ''}`
      const lines = [
        `${run.id} · ${head} · ${outcome.durationMs}ms`,
        `- 命令：${commandText}`,
        `- 记录：${run.recordFile}`,
      ]
      if (run.probeLines.length === 0) {
        lines.push('- 探针输出：无（检查是否用了 [probe] 前缀，或 collect=false）')
      } else {
        lines.push(`- 探针输出 ${run.probeLines.length} 行：`)
        for (const line of run.probeLines.slice(0, 12)) lines.push(`  ${line}`)
        if (run.probeLines.length > 12) lines.push(`  …（还有 ${run.probeLines.length - 12} 行，见记录文件）`)
      }
      if (outcome.stderr && outcome.stderr.trim() !== '') {
        lines.push('- stderr 尾部：')
        lines.push(tailText(outcome.stderr, 8, 1200).split('\n').map((line) => `  ${line}`).join('\n'))
      }
      const note = autoNote(session, created)
      if (note) lines.push(note)
      return {
        summary: lines.join('\n'),
        result: {
          run,
          stdout: tailText(outcome.stdout ?? '', 60, 6000),
          stderr: tailText(outcome.stderr ?? '', 40, 4000),
        },
      }
    },
  }))

  // ── 6. probe_clean ───────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_clean',
    timeoutMs: 600000,
    description:
      'Tear the probe session down: remove every recorded marker block from the files (surgically, so later '
      + 'edits elsewhere in those files survive), compare each file against its baseline, delete the temporary '
      + 'probe scripts, and report anything that could not be restored. dryRun=true shows the plan without '
      + 'touching anything. purge=true additionally deletes .probe/ itself (keeps PROBE.md unless purgeNotes).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        dryRun: { type: 'boolean', description: 'Only report what would be done.' },
        keepScripts: { type: 'boolean', description: 'Keep .probe/scripts/ files (default false: they are temporary).' },
        purge: { type: 'boolean', description: 'Delete .probe/ entirely after cleanup (runs/ evidence included).' },
        purgeNotes: { type: 'boolean', description: 'With purge: also delete PROBE.md.' },
        scanAll: { type: 'boolean', description: 'Also strip markers from any file the guard finds, even if the session does not list it.' },
      },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const session = loadSession(cwd, options)
      const dryRun = args.dryRun === true
      if (!session) {
        const scan = await guardScan({ cwd, scope: 'worktree', paths, options })
        if (scan.ok) {
          return { summary: '没有探针会话，工作区里也没有探针标记。干净的。', result: { ok: true, offenders: [] } }
        }
        return {
          summary: [
            `没有探针会话，但工作区里有 ${scan.offenders.length} 处疑似探针标记：`,
            ...scan.offenders.slice(0, 12).map((offender) => `- ${offender.file}:${offender.line} ${offender.text}`),
            '这些不是本插件记录的，需要手动处理；直接 probe_insert 会在当前工作区自动接手，或 probe_begin 显式开一次。',
          ].join('\n'),
          result: { ok: false, offenders: scan.offenders },
        }
      }

      const files = [...new Set((session.probes ?? []).map((probe) => probe.file))]
      const restored = []
      const changed = []
      const missing = []
      const residual = []
      const deleted = []

      for (const rel of files) {
        const abs = path.resolve(cwd, rel)
        const before = readText(abs)
        if (before === null) {
          missing.push(rel)
          continue
        }
        const stripped = stripMarkers(before)
        const baseline = loadBaseline(cwd, rel, options)
        // 基线存在但拆完还和它不一致 = 你在探针之外也改了这个文件；此时只拆探针块，别的改动保留。
        const matchesBaseline = baseline === null ? null : stripped.text === baseline
        // 整份文件就是探针建出来的（create=true），拆完正好回到骨架 → 连文件一起删掉，不留空壳。
        const probeCreated = (session.probes ?? []).filter((probe) => probe.file === rel).every((probe) => probe.created === true)
        if (!dryRun) {
          if (probeCreated && matchesBaseline === true) {
            fs.rmSync(abs, { force: true })
            deleted.push(rel)
          } else {
            writeText(abs, stripped.text)
          }
        }
        if (matchesBaseline === false) changed.push(rel)
        if (stripped.residuals.length > 0) residual.push({ file: rel, items: stripped.residuals })
        restored.push({
          file: rel,
          removedBlocks: stripped.removed.length,
          removedLines: stripped.removed.reduce((sum, item) => sum + item.lines, 0),
          matchesBaseline,
        })
      }

      // scanAll：把 session 没记录、但工作区里还带标记的文件也清掉。
      const extra = []
      if (args.scanAll === true) {
        const scan = await guardScan({ cwd, scope: 'worktree', paths, options })
        for (const offender of scan.offenders) {
          if (files.includes(offender.file)) continue
          const abs = path.resolve(cwd, offender.file)
          const text = readText(abs)
          if (text === null) continue
          const stripped = stripMarkers(text)
          if (stripped.removed.length === 0) continue
          if (!dryRun) writeText(abs, stripped.text)
          extra.push({ file: offender.file, removedBlocks: stripped.removed.length })
        }
      }

      const scriptsRemoved = []
      if (!dryRun && args.keepScripts !== true) {
        for (const script of session.scripts ?? []) {
          try {
            fs.rmSync(path.resolve(cwd, script.file), { force: true })
            scriptsRemoved.push(script.file)
          } catch {
            // 已经不在了。
          }
        }
        session.scripts = []
      }

      // 复核：拆完再扫一遍会话涉及的文件，确认没有配不上的标记。
      const after = dryRun ? null : await residualScan({ cwd, session })

      if (!dryRun) {
        for (const rel of Object.keys(session.baseline ?? {})) dropBaseline(cwd, session, rel, options)
        session.probes = []
        session.cleanedAt = nowIso()
        if (args.purge === true) {
          fs.rmSync(paths.dir, { recursive: true, force: true })
          if (args.purgeNotes === true) {
            try { fs.rmSync(paths.ledgerFile, { force: true }) } catch { /* 可能本来就没有 */ }
          }
        } else {
          saveSession(cwd, session, options)
        }
      }

      const lines = [
        `${dryRun ? '[dry run] ' : ''}探针拆除报告 · 会话 ${session.id}`,
        `- 处理文件 ${files.length} 个，其中 ${restored.filter((item) => item.removedBlocks > 0).length} 个真的拆了块`,
      ]
      for (const item of restored) {
        if (item.removedBlocks === 0) continue
        const flag = item.matchesBaseline === false ? '（其它行也被改过，只拆了探针块）' : '（与基线一致）'
        lines.push(`  · ${item.file}：拆 ${item.removedBlocks} 块 / ${item.removedLines} 行 ${flag}`)
      }
      if (restored.length > 0 && restored.every((item) => item.removedBlocks === 0)) lines.push('- 没有残留标记需要拆除')
      if (missing.length > 0) lines.push(`- 文件已不存在：${missing.join(', ')}`)
      if (changed.length > 0) lines.push(`- 警告：${changed.length} 个文件在探针之外还有改动（${changed.join(', ')}），只拆了探针块，其余保留`)
      if (residual.length > 0) {
        lines.push(`- 警告：${residual.length} 个文件还有配不上的标记（可能是手工插的或文件被改坏）：`)
        for (const item of residual.slice(0, 8)) {
          for (const entry of item.items.slice(0, 3)) lines.push(`  · ${item.file}:${entry.line} ${entry.type} ${entry.id}`)
        }
      }
      if (extra.length > 0) lines.push(`- scanAll 额外清理：${extra.map((item) => `${item.file}(${item.removedBlocks})`).join(', ')}`)
      if (deleted.length > 0) lines.push(`- 整份文件由探针新建（create=true），拆完已删除：${deleted.join(', ')}`)
      if (scriptsRemoved.length > 0) lines.push(`- 删除临时脚本 ${scriptsRemoved.length} 个`)
      if (after) {
        lines.push(after.ok
          ? '- 复核：会话涉及的文件已无探针标记。'
          : `- 复核：仍有 ${after.offenders.length} 处标记（${after.offenders.slice(0, 6).map((o) => `${o.file}:${o.line}`).join(', ')}），处理完再提交。`)
      }
      if (args.purge === true && !dryRun) lines.push('- 已按 purge 删除 .probe/')
      lines.push('- 最后一步：probe_guard（防止标记漏进提交），然后 probe_report 记账。')
      return {
        summary: lines.join('\n'),
        result: { dryRun, restored, changed, missing, residual, extra, deleted, scriptsRemoved, after },
      }
    },
  }))

  // ── 7. probe_guard ───────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_guard',
    timeoutMs: 600000,
    description:
      'Scan the project for leftover dsh-probe markers and report file:line — the check that stops a probe '
      + 'from reaching a commit. scope=worktree scans tracked plus untracked-but-not-ignored files, scope=staged '
      + 'scans only the index, scope=all does both. Also warns when .probe/ itself is tracked by git. Run it '
      + 'before every commit; a green guard is the whole point of using temporary probes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        scope: { type: 'string', enum: ['worktree', 'staged', 'all'], description: 'What to scan (default worktree).' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit to these files/directories.' },
      },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const scope = oneOf(args.scope, ['worktree', 'staged', 'all'], 'worktree', 'scope')
      const scan = await guardScan({
        cwd,
        scope,
        paths,
        options,
        onlyPaths: Array.isArray(args.paths) ? args.paths : undefined,
      })
      const lines = []
      if (scan.ok) {
        lines.push(`守卫通过：扫了 ${scan.scannedFiles} 个文件，没有探针标记。`)
      } else {
        lines.push(`守卫拦下：${scan.offenders.length} 处探针标记（扫了 ${scan.scannedFiles} 个文件）`)
        for (const offender of scan.offenders.slice(0, 20)) lines.push(`- ${offender.file}:${offender.line} ${offender.text}`)
        if (scan.offenders.length > 20) lines.push(`…（还有 ${scan.offenders.length - 20} 处）`)
        lines.push('处理：probe_clean（本插件插的），或手工删掉再跑一次 probe_guard。')
      }
      for (const warning of scan.warnings ?? []) lines.push(`- 警告：${warning}`)
      lines.push(`- ${GUARD_SKIP_NOTE}`)
      return { summary: lines.join('\n'), result: scan }
    },
  }))

  // ── 8. probe_report ──────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_report',
    timeoutMs: 60000,
    description:
      'Record what the probe taught you — the question, the method, the finding, and whether it was explained '
      + 'or refuted — into PROBE.md and .probe/ledger.json. Probes are deleted; the answers are not. A refuted '
      + 'hypothesis is worth as much as a confirmed one, so record both.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: CWD_SCHEMA,
        action: { type: 'string', enum: ['append', 'list', 'summary'], description: 'Default append.' },
        question: { type: 'string', description: 'What were you trying to find out?' },
        method: { type: 'string', description: 'How did you probe it (insert points, script, command)?' },
        findings: { type: 'string', description: 'What did the output actually show?' },
        verdict: { type: 'string', enum: VERDICTS, description: 'explained | refuted | inconclusive.' },
        notes: { type: 'string', description: 'Caveats, next step, or what to try instead.' },
        limit: { type: 'integer', description: 'list: how many recent entries (default 20).' },
      },
    },
    async run(args, exec) {
      const { cwd, options, paths } = await contextFor(args, exec)
      const action = oneOf(args.action, ['append', 'list', 'summary'], 'append', 'action')
      if (action === 'append') {
        const entry = appendLedger({ cwd, paths }, {
          question: requireText(args.question, 'question'),
          method: args.method,
          findings: args.findings,
          verdict: oneOf(args.verdict, VERDICTS, 'inconclusive', 'verdict'),
          notes: args.notes,
        })
        // 惰性初始化的会话没有 goal；记账时顺手把问题写进去，会话就不再是「没有目标」的状态。
        const session = loadSession(cwd, options)
        let filledGoal = false
        if (session && !session.goal) {
          session.goal = entry.entry.question
          saveSession(cwd, session, options)
          filledGoal = true
        }
        return {
          summary: [
            `已记账 ${entry.id} → ${entry.file}`,
            `- 结论：${entry.entry.verdict}`,
            entry.entry.findings ? `- 发现：${entry.entry.findings}` : '- （未填 findings）',
            filledGoal ? '- 已顺带把这个问题写成当前会话的 goal。' : null,
            '- 记住：探针会被删掉，结论不会，所以它必须自己站得住。',
          ].filter(Boolean).join('\n'),
          result: filledGoal ? { ...entry, filledGoal: true } : entry,
        }
      }
      if (action === 'list') {
        const result = listLedger({ paths }, { limit: numberIn(args.limit, 20, 1, 500) })
        if (result.total === 0) return { summary: '账本还是空的。probe_report action=append 记一条。', result }
        const lines = [`账本 ${result.total} 条，最近 ${result.items.length} 条：`]
        for (const item of result.items) lines.push(`- ${item.id} [${item.verdict}] ${item.question}`)
        return { summary: lines.join('\n'), result }
      }
      const summary = ledgerSummary({ paths })
      const lines = [
        `账本总计 ${summary.total} 条`,
        `- explained ${summary.byVerdict.explained ?? 0} · refuted ${summary.byVerdict.refuted ?? 0} · inconclusive ${summary.byVerdict.inconclusive ?? 0}`,
      ]
      if (summary.last) lines.push(`- 最近：${summary.last.id} ${summary.last.question}`)
      return { summary: lines.join('\n'), result: summary }
    },
  }))

  // ── 9. probe_guide ───────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'probe_guide',
    timeoutMs: 10000,
    description:
      'Read the probe playbook: when a probe is the right tool at all, the marker format, how to insert and '
      + 'indent, the [probe] output convention, how to write a throwaway script, the teardown and guard '
      + 'checklist, and the pitfalls that make temporary probes rot into permanent code.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: {
          type: 'string',
          enum: GUIDE_SECTIONS,
          description: 'Which section to return (default workflow).',
        },
      },
    },
    async run(args) {
      const section = oneOf(args.section, GUIDE_SECTIONS, 'workflow', 'section')
      return { summary: guide(section), result: { section } }
    },
  }))

  registerSkill(ctx)
}

function sessionRel(cwd, file) {
  return path.relative(cwd, file).split(path.sep).join('/') || file
}

function baselineRel(cwd, options, rel) {
  const paths = resolvePaths(cwd, options)
  return sessionRel(cwd, path.join(paths.baselineDir, rel.split(/[\\/]+/).filter(Boolean).join('__')))
}

function registerSkill(ctx) {
  if (typeof ctx.inject !== 'function') return
  let content
  try {
    content = readFileSync(path.join(PLUGIN_DIR, 'skill', 'probe.md'), 'utf8')
  } catch {
    return
  }
  try {
    ctx.inject(['skills'], (child) => {
      try {
        child.skills.register({
          name: 'probe',
          description:
            'Use when a change needs temporary instrumentation or a throwaway verification script: insert '
            + 'greppable probes into source, run them, read [probe] output, then tear everything down '
            + 'byte-identically and guard against leftovers.',
          whenToUse:
            'The user asks to debug by printing state, to verify behavior after an edit, to reproduce a bug '
            + 'with a scratch script, or to check that no debug code was left behind.',
          content,
          source: 'dsh-probe',
          invocation: { modelInvocable: true, userInvocable: true },
        })
      } catch (error) {
        ctx.logger?.warn?.(`probe: runtime skill registration failed: ${error.message}`)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`probe: skills service unavailable: ${error.message}`)
  }
}
