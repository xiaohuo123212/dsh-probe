// 项目级上下文：cwd 解析、选项合并、路径解析。契约见 CONTRACT.md。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { insidePath, isPlainObject, readJson, toAbs } from './util.js'

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULTS = {
  dataDir: '.probe',
  ledgerFile: 'PROBE.md',
  configFile: 'probe.json',
  defaultTimeoutSec: 120,
  maxOutputBytes: 1048576,
  maxScanBytes: 2097152,
  maxRuns: 200,
  exclude: ['node_modules', '.git', 'dist', 'build', 'out', '.venv', '__pycache__', '.probe/baseline', '.probe/runs'],
  powershell: undefined,
}

const PROJECT_KEYS = new Set(Object.keys(DEFAULTS))

/** 一次调用的项目目录：显式 cwd > 会话工作目录 > 进程目录。 */
export function resolveCwd(ctx, exec, args) {
  if (typeof args?.cwd === 'string' && args.cwd.trim() !== '') {
    return toAbs(process.cwd(), args.cwd.trim())
  }
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory && exec?.agent?.session) {
    try {
      const dir = workingDirectory.get(exec.agent.session)
      if (typeof dir === 'string' && dir !== '') return dir
    } catch {
      // 回落到进程目录。
    }
  }
  return process.cwd()
}

export async function loadOptions(cwd, pluginConfig = {}) {
  const options = { ...DEFAULTS, exclude: [...DEFAULTS.exclude] }
  for (const [key, value] of Object.entries(pluginConfig ?? {})) {
    if (PROJECT_KEYS.has(key) && value !== undefined) options[key] = value
  }
  const project = await readJson(path.join(cwd, String(options.configFile ?? 'probe.json')), undefined)
  if (isPlainObject(project)) {
    for (const [key, value] of Object.entries(project)) {
      if (PROJECT_KEYS.has(key) && value !== undefined) options[key] = value
    }
  }
  return options
}

/** 所有落盘路径都必须在项目内，且 dataDir 不能是项目根本身。 */
export function resolvePaths(cwd, options = DEFAULTS) {
  const root = path.resolve(cwd)
  const dir = path.resolve(root, String(options.dataDir ?? '.probe'))
  if (dir === root || !insidePath(root, dir)) {
    throw new Error(`dataDir 必须是项目下的子目录（当前解析为 ${dir}）`)
  }
  const ledgerFile = path.resolve(root, String(options.ledgerFile ?? 'PROBE.md'))
  if (!insidePath(root, ledgerFile)) {
    throw new Error(`ledgerFile 必须留在项目内（当前解析为 ${ledgerFile}）`)
  }
  return {
    root,
    dir,
    sessionFile: path.join(dir, 'session.json'),
    baselineDir: path.join(dir, 'baseline'),
    scriptsDir: path.join(dir, 'scripts'),
    runsDir: path.join(dir, 'runs'),
    tmpDir: path.join(dir, 'tmp'),
    ledgerJson: path.join(dir, 'ledger.json'),
    ledgerFile,
  }
}

export function numberIn(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`需要数字，收到 ${JSON.stringify(value)}`)
  if (parsed < min || parsed > max) throw new Error(`需要 ${min}..${max}，收到 ${parsed}`)
  return parsed
}

export function oneOf(value, allowed, fallback, name = 'value') {
  if (value === undefined || value === null || value === '') return fallback
  if (!allowed.includes(value)) {
    throw new Error(`${name} 只能是 ${allowed.join(' | ')}，收到 ${JSON.stringify(value)}`)
  }
  return value
}

export function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} 不能为空`)
  return value
}
