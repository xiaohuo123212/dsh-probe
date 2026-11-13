// dsh-probe — 子进程执行与运行记录。契约见 CONTRACT.md（模块契约 → lib/runner.js）。
// 只用 node: 内置模块；不打印到 stdout（会污染工具输出）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DEFAULTS, numberIn } from './project.js'
import { nextRunId } from './store.js'
import { ensureDir, nowIso, relPosix, slugify, tailText, toAbs, writeJson } from './util.js'

/** 超时被杀时的退出码（沿用 GNU timeout 的约定）。 */
export const TIMEOUT_EXIT_CODE = 124
/** 命令根本没起来（找不到可执行文件等）。 */
export const SPAWN_FAIL_EXIT_CODE = 127
/** 被 AbortSignal 中止。 */
export const ABORTED_EXIT_CODE = 130
/** 运行记录里 stdout/stderr 落盘时的截尾上限。 */
export const RUN_TAIL_LINES = 200
export const RUN_TAIL_CHARS = 20000

/** Windows 上 taskkill 失败后，隔多久改用 TerminateProcess 兜底。 */
const KILL_GRACE_MS = 500
/** 杀不掉也别把调用方吊死：多久之后强制结算。 */
const FORCE_SETTLE_MS = 3000
/** 探针输出约定：[probe] 前缀行，或 PROBE| 前缀行（大小写不敏感）。 */
const PROBE_LINE_RE = /^(?:\[probe\]|probe\|)/i

/**
 * 抽探针行。只认 `[probe] ...` 与 `PROBE|...`（大小写不敏感，允许前导空白），
 * 返回去掉首尾空白的原始行。
 */
export function extractProbeLines(stdout) {
  if (typeof stdout !== 'string' || stdout === '') return []
  const lines = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && PROBE_LINE_RE.test(trimmed)) lines.push(trimmed)
  }
  return lines
}

/**
 * 一路输出的收集器：保留前 limitBytes 字节作为 stdout/stderr 文本，
 * 同时从**完整**输出里抽 probeLines 并统计被丢掉的字节数。
 * 这样即使输出超限，[probe] 行也不会被截没。
 */
function createCapture(limitBytes) {
  const decoder = new StringDecoder('utf8')
  const chunks = []
  let kept = 0
  let dropped = 0
  let pending = ''
  const probeLines = []

  const scanLine = (line) => {
    if (line === '') return
    const trimmed = line.trim()
    if (trimmed !== '' && PROBE_LINE_RE.test(trimmed)) probeLines.push(trimmed)
  }

  const feed = (text) => {
    if (text === '') return
    pending += text
    let index
    while ((index = pending.indexOf('\n')) !== -1) {
      scanLine(pending.slice(0, index))
      pending = pending.slice(index + 1)
    }
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return
      feed(decoder.write(chunk))
      if (kept < limitBytes) {
        const room = limitBytes - kept
        if (chunk.length <= room) {
          chunks.push(chunk)
          kept += chunk.length
        } else {
          chunks.push(chunk.subarray(0, room))
          kept = limitBytes
          dropped += chunk.length - room
        }
      } else {
        dropped += chunk.length
      }
    },
    finish() {
      feed(decoder.end())
      if (pending !== '') {
        scanLine(pending)
        pending = ''
      }
      return { text: Buffer.concat(chunks).toString('utf8'), probeLines, truncated: dropped > 0 }
    },
  }
}

function safeClose(fd) {
  try { fs.closeSync(fd) } catch { /* 已关闭 */ }
}

function safeRm(dir) {
  if (!dir) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
}

/** 把文件内容喂给收集器（只在「管道被禁」的兜底模式下用）。 */
function readFileInto(file, capture) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      capture.push(read === buffer.length ? buffer : buffer.subarray(0, read))
    }
  } catch {
    // 文件不存在 / 读不了就等于「没有输出」。
  } finally {
    if (fd !== undefined) safeClose(fd)
  }
}

function isPipeDenied(error) {
  return Boolean(error) && (error.code === 'EPERM' || error.code === 'EACCES')
}

/**
 * 起子进程收输出。首选 pipe（契约要求）；如果当前环境禁止创建管道
 * （受限沙箱里 spawn 会直接 EPERM），退化成把输出重定向到临时文件再读回来，
 * 对外语义完全一致。
 */
function spawnCapture({ cwd, file, argv, env, shell, detached }) {
  const base = { cwd, env, windowsHide: true, shell, detached }
  try {
    const child = spawn(file, argv, { ...base, stdio: ['ignore', 'pipe', 'pipe'] })
    return { child, mode: 'pipe', dir: null }
  } catch (error) {
    if (!isPipeDenied(error)) throw error
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-run-'))
  const outPath = path.join(dir, 'stdout.log')
  const errPath = path.join(dir, 'stderr.log')
  let outFd
  let errFd
  try {
    outFd = fs.openSync(outPath, 'w')
    errFd = fs.openSync(errPath, 'w')
    const child = spawn(file, argv, { ...base, stdio: ['ignore', outFd, errFd] })
    // 子进程已经继承句柄，父进程这两份不再需要（读文件按路径读）。
    safeClose(outFd)
    safeClose(errFd)
    return { child, mode: 'file', dir, outPath, errPath }
  } catch (error) {
    safeClose(outFd)
    safeClose(errFd)
    safeRm(dir)
    throw error
  }
}

/** 杀进程树：Windows 用 taskkill /T /F，其余用 SIGKILL（必要时整个进程组）。 */
function killTree(child, timers) {
  if (!child || typeof child.pid !== 'number') return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { /* 交给下面的 TerminateProcess 兜底 */ })
    } catch { /* 交给下面的 TerminateProcess 兜底 */ }
    // taskkill 可能因安全策略被拒绝（rc=1 / Access denied），隔一会儿直接 TerminateProcess。
    timers.add(setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
    }, KILL_GRACE_MS))
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
  }
}

function mergeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return process.env
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete merged[key]
    else merged[key] = String(value)
  }
  return merged
}

function planCommand(command) {
  if (Array.isArray(command)) {
    const parts = command.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
    if (parts.length === 0 || parts[0].trim() === '') {
      throw new Error('command 数组至少要有一个可执行文件名（string[] 是首选写法，不经过 shell）')
    }
    return { file: parts[0], argv: parts.slice(1), shell: false }
  }
  if (typeof command === 'string') {
    if (command.trim() === '') throw new Error('command 不能为空（string 走平台 shell，string[] 直接 spawn）')
    return { file: command, argv: [], shell: true }
  }
  throw new Error('command 必须是 string（走平台 shell）或 string[]（直接 spawn，首选）')
}

function resolveTimeoutMs(timeoutSec) {
  if (timeoutSec === 0) return 0
  return Math.round(numberIn(timeoutSec, DEFAULTS.defaultTimeoutSec, 1, 86400) * 1000)
}

/**
 * 跑一条命令。非 0 退出码**不抛错**——把它当成信息交回调用方。
 * @returns {Promise<{exitCode:number|null, signal:string|null, durationMs:number,
 *   stdout:string, stderr:string, probeLines:string[], truncated:boolean, timedOut:boolean}>}
 */
export async function runCommand({ cwd, command, timeoutSec, env, collect = true, label, signal, maxOutputBytes } = {}) {
  const root = typeof cwd === 'string' && cwd.trim() !== '' ? path.resolve(cwd) : process.cwd()
  const plan = planCommand(command)
  const timeoutMs = resolveTimeoutMs(timeoutSec)
  const limit = numberIn(maxOutputBytes, DEFAULTS.maxOutputBytes, 1, 1 << 30)
  const started = Date.now()

  if (signal && signal.aborted) {
    return {
      exitCode: ABORTED_EXIT_CODE, signal: null, durationMs: 0,
      stdout: '', stderr: '', probeLines: [], truncated: false, timedOut: false, aborted: true,
    }
  }

  const attempt = spawnCapture({
    cwd: root,
    file: plan.file,
    argv: plan.argv,
    env: mergeEnv(env),
    shell: plan.shell,
    detached: process.platform !== 'win32',
  })

  return await new Promise((resolve) => {
    const outCapture = createCapture(limit)
    const errCapture = createCapture(limit)
    const timers = new Set()
    let settled = false
    let timedOut = false
    let aborted = false
    let spawnError = null

    const detachStreams = () => {
      if (attempt.mode !== 'pipe') return
      for (const stream of [attempt.child.stdout, attempt.child.stderr]) {
        if (!stream) continue
        stream.removeAllListeners('data')
        stream.destroy()
      }
    }

    const settle = (code, sig) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      if (attempt.mode === 'file') {
        readFileInto(attempt.outPath, outCapture)
        readFileInto(attempt.errPath, errCapture)
      }
      detachStreams()
      safeRm(attempt.dir)

      const out = outCapture.finish()
      const err = errCapture.finish()
      let exitCode = typeof code === 'number' ? code : null
      if (spawnError) exitCode = SPAWN_FAIL_EXIT_CODE
      if (aborted && exitCode === null) exitCode = ABORTED_EXIT_CODE
      if (timedOut) exitCode = TIMEOUT_EXIT_CODE

      const result = {
        exitCode,
        signal: typeof sig === 'string' ? sig : null,
        durationMs: Date.now() - started,
        stdout: out.text,
        stderr: spawnError ? [err.text, spawnError.message].filter(Boolean).join('\n') : err.text,
        probeLines: collect ? out.probeLines : [],
        truncated: out.truncated || err.truncated,
        timedOut,
      }
      if (aborted) result.aborted = true
      resolve(result)
    }

    if (attempt.mode === 'pipe') {
      attempt.child.stdout?.on('data', (chunk) => outCapture.push(chunk))
      attempt.child.stderr?.on('data', (chunk) => errCapture.push(chunk))
    }
    attempt.child.on('error', (error) => {
      spawnError = error
      settle(null, null)
    })
    attempt.child.on('close', (code, sig) => settle(code, sig))

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        timedOut = true
        killTree(attempt.child, timers)
        timers.add(setTimeout(() => settle(null, 'SIGKILL'), FORCE_SETTLE_MS))
      }, timeoutMs)
      timers.add(timer)
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree(attempt.child, timers)
      timers.add(setTimeout(() => settle(null, 'SIGKILL'), FORCE_SETTLE_MS))
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** runtime → argv。node 用当前 node 解释器，避免 PATH 里的版本不一致。 */
export function runtimeCommand(runtime, file, args = []) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('脚本路径不能为空')
  const rest = (Array.isArray(args) ? args : args === undefined || args === null ? [] : [args]).map((item) => String(item))
  const kind = String(runtime ?? 'node').toLowerCase()
  switch (kind) {
    case 'node':
      return [process.execPath, file, ...rest]
    case 'python':
    case 'python3':
      return ['python', file, ...rest]
    case 'powershell':
    case 'pwsh':
      return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...rest]
    default:
      throw new Error(`不支持的脚本 runtime：${runtime}（可用 node | python | powershell）`)
  }
}

function sessionRoot(cwd, session) {
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd)
  if (session && typeof session.cwd === 'string' && session.cwd.trim() !== '') return path.resolve(session.cwd)
  return process.cwd()
}

/**
 * 跑 session 里登记过的探针脚本。没登记就报错并提示用 probe_script action=new。
 */
export async function runScript({ cwd, session, name, args, timeoutSec, signal, env, collect = true } = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('缺少探针会话：先调用 probe_begin 开一次会话。')
  }
  const wanted = String(name ?? '').trim()
  if (wanted === '') throw new Error('脚本名不能为空（用 probe_script action=list 看看有哪些）。')
  const script = (Array.isArray(session.scripts) ? session.scripts : []).find((item) => item && item.name === wanted)
  if (!script) {
    throw new Error(`没有登记名为 ${wanted} 的探针脚本。先用 probe_script action=new 建一个（name="${wanted}"）。`)
  }
  const root = sessionRoot(cwd, session)
  const file = toAbs(root, String(script.file ?? ''))
  if (!fs.existsSync(file)) {
    throw new Error(`探针脚本文件不见了：${script.file}。用 probe_script action=list 看看还剩什么，或 action=new 重建。`)
  }
  const argv = runtimeCommand(script.runtime, file, args)
  const result = await runCommand({ cwd: root, command: argv, timeoutSec, env, collect, label: wanted, signal })
  return {
    ...result,
    script: { name: script.name, runtime: script.runtime, file: script.file },
    argv,
  }
}

/** 记录文件名里的时间戳：20261113-012700（本地时间，人能读）。 */
export function stampNow(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 写 .probe/runs/<ts>-<slug>.json，返回相对 cwd 的正斜杠路径。
 * 同时把这条 run 推进 session.runs（保存 session 是工具层的事），
 * stdout/stderr 落盘前用 tailText 截尾，session.runs 超过 maxRuns 丢最旧的。
 */
export function writeRunRecord(paths, session, run = {}, opts = {}) {
  if (!paths || typeof paths !== 'object' || typeof paths.runsDir !== 'string') {
    throw new Error('writeRunRecord 需要 resolvePaths() 返回的 paths（至少要 runsDir）')
  }
  if (!session || typeof session !== 'object') {
    throw new Error('writeRunRecord 需要探针会话对象（先 probe_begin）')
  }
  const root = typeof paths.root === 'string' ? paths.root : path.dirname(paths.runsDir)
  ensureDir(paths.runsDir)

  const id = String(run.id ?? '') || nextRunId(session)
  const label = typeof run.label === 'string' ? run.label : ''
  const commandText = Array.isArray(run.command) ? run.command.join(' ') : String(run.command ?? '')
  const slug = slugify(label || commandText || 'run') || 'run'
  const stamp = stampNow()

  let file = path.join(paths.runsDir, `${stamp}-${slug}.json`)
  for (let n = 2; fs.existsSync(file); n += 1) {
    file = path.join(paths.runsDir, `${stamp}-${slug}-${n}.json`)
  }

  const entry = {
    id,
    label,
    command: commandText,
    exitCode: run.exitCode ?? null,
    signal: run.signal ?? null,
    durationMs: run.durationMs ?? 0,
    truncated: run.truncated === true,
    timedOut: run.timedOut === true,
    probeLines: Array.isArray(run.probeLines) ? run.probeLines : [],
    recordFile: relPosix(root, file),
    createdAt: run.createdAt ?? nowIso(),
  }
  const record = {
    ...entry,
    cwd: root,
    stdout: tailText(typeof run.stdout === 'string' ? run.stdout : '', RUN_TAIL_LINES, RUN_TAIL_CHARS),
    stderr: tailText(typeof run.stderr === 'string' ? run.stderr : '', RUN_TAIL_LINES, RUN_TAIL_CHARS),
  }
  writeJson(file, record)

  session.runs = Array.isArray(session.runs) ? session.runs : []
  session.runs.push(entry)

  const requested = Number(opts?.maxRuns ?? session.maxRuns ?? DEFAULTS.maxRuns)
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULTS.maxRuns
  while (session.runs.length > limit) session.runs.shift()

  return entry.recordFile
}
