// 探针会话的持久化。唯一状态文件是 .probe/session.json。
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, resolvePaths } from './project.js'
import { ensureDir, lineCount, makeId, nowIso, readJson, readText, relPosix, sha256, writeJson, writeText } from './util.js'

export const SESSION_VERSION = 1

export function probePaths(cwd, options = DEFAULTS) {
  return resolvePaths(cwd, options)
}

export function loadSession(cwd, options = DEFAULTS) {
  const paths = probePaths(cwd, options)
  const session = readJson(paths.sessionFile, null)
  if (!session || typeof session !== 'object') return null
  if (session.version !== SESSION_VERSION) return null
  if (!Array.isArray(session.probes)) session.probes = []
  if (!Array.isArray(session.scripts)) session.scripts = []
  if (!Array.isArray(session.runs)) session.runs = []
  if (!session.baseline || typeof session.baseline !== 'object') session.baseline = {}
  return session
}

export function saveSession(cwd, session, options = DEFAULTS) {
  const paths = probePaths(cwd, options)
  touchSession(session)
  ensureDir(paths.dir)
  writeJson(paths.sessionFile, session)
  return session
}

export function touchSession(session) {
  session.updatedAt = nowIso()
  return session
}

export function requireSession(cwd, options = DEFAULTS) {
  const session = loadSession(cwd, options)
  if (!session) {
    throw new Error('这个项目还没有探针会话。先调用 probe_begin 开一次（它会在 .probe/ 下记账）。')
  }
  return session
}

/** 基线副本按相对路径打平存放，避免目录穿越。 */
export function baselineFile(cwd, rel, options = DEFAULTS) {
  const paths = probePaths(cwd, options)
  const flat = String(rel).split(/[\\/]+/).filter(Boolean).join('__')
  return path.join(paths.baselineDir, flat)
}

/** 第一次给某文件拍基线；已拍过则不动（保证基线永远是「动手之前」的那一版）。 */
export function saveBaseline(cwd, session, rel, text, options = DEFAULTS) {
  if (session.baseline && session.baseline[rel]) return false
  const target = baselineFile(cwd, rel, options)
  writeText(target, text ?? '')
  session.baseline = session.baseline ?? {}
  session.baseline[rel] = {
    sha256: sha256(text ?? ''),
    bytes: Buffer.byteLength(text ?? '', 'utf8'),
    lines: lineCount(text ?? ''),
    savedAt: nowIso(),
  }
  return true
}

export function loadBaseline(cwd, rel, options = DEFAULTS) {
  return readText(baselineFile(cwd, rel, options))
}

export function dropBaseline(cwd, session, rel, options = DEFAULTS) {
  const target = baselineFile(cwd, rel, options)
  try { fs.unlinkSync(target) } catch { /* 已不存在 */ }
  if (session.baseline) delete session.baseline[rel]
}

/** 会话 id：pr-YYYYMMDD-HHMMSS-xxxx（带随机后缀，同一秒内开两次也不会撞）。 */
export function makeSessionId() {
  return makeId('pr')
}

/**
 * 惰性初始化：第一次在某个工作区使用任意 probe_* 时就建好 .probe/ 和会话，
 * 不需要先调用 probe_begin。上一次会话已经 clean 过 → 直接开新的一轮。
 * @returns {{session: object, created: boolean}}
 */
export function ensureSession(cwd, options = DEFAULTS, { label } = {}) {
  const existing = loadSession(cwd, options)
  if (existing && !existing.cleanedAt) return { session: existing, created: false }
  const paths = probePaths(cwd, options)
  for (const dir of [paths.dir, paths.baselineDir, paths.scriptsDir, paths.runsDir, paths.tmpDir]) ensureDir(dir)
  const root = path.resolve(cwd)
  const session = {
    version: SESSION_VERSION,
    id: makeSessionId(),
    label: typeof label === 'string' && label.trim() !== '' ? label.trim() : path.basename(root) || undefined,
    goal: null,
    startedAt: nowIso(),
    cwd: root.split(path.sep).join('/'),
    autoStarted: true,
    baseline: {},
    probes: [],
    scripts: [],
    runs: [],
  }
  saveSession(cwd, session, options)
  return { session, created: true }
}

export function nextProbeId(session) {
  let max = 0
  for (const probe of session.probes ?? []) {
    const match = /^p(\d+)$/.exec(String(probe.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `p${max + 1}`
}
export function nextRunId(session) {
  let max = 0
  for (const run of session.runs ?? []) {
    const match = /^r(\d+)$/.exec(String(run.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `r${max + 1}`
}

export function probesForFile(session, rel) {
  return (session.probes ?? []).filter((probe) => probe.file === rel)
}

export function sessionDigest(cwd, session) {
  const probes = session.probes ?? []
  return {
    id: session.id,
    label: session.label,
    goal: session.goal,
    startedAt: session.startedAt,
    probes: probes.length,
    files: new Set(probes.map((p) => p.file)).size,
    scripts: (session.scripts ?? []).length,
    runs: (session.runs ?? []).length,
    cleanedAt: session.cleanedAt ?? null,
  }
}

export function relativeFromCwd(cwd, abs) {
  return relPosix(cwd, abs)
}
