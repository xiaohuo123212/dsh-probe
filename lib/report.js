// dsh-probe — 探针账本：结构化数据写 .probe/ledger.json，人读版本追加到 PROBE.md。
// 契约见 CONTRACT.md「lib/report.js」。所有写盘走 util 的原子写（无 BOM）。
import path from 'node:path'
import { DEFAULTS, oneOf, resolvePaths } from './project.js'
import { isPlainObject, nowIso, readJson, readText, relPosix, writeJson, writeText } from './util.js'

/** verdict 的合法取值，顺序即报告里展示的顺序。 */
export const VERDICTS = ['explained', 'refuted', 'inconclusive']

export const LEDGER_TITLE = '# 探针账本（probe ledger）'
const LEDGER_INTRO = '> 每次 probe_report 追加一节：想弄清什么、怎么测的、看到了什么、结论是什么。'
const DEFAULT_LIMIT = 20

// ---------------------------------------------------------------------------
// 路径与读取
// ---------------------------------------------------------------------------

function fallbackPaths(cwd, options = DEFAULTS) {
  const root = path.resolve(cwd)
  const dir = path.resolve(root, String(options.dataDir ?? DEFAULTS.dataDir))
  return {
    root,
    dir,
    sessionFile: path.join(dir, 'session.json'),
    baselineDir: path.join(dir, 'baseline'),
    scriptsDir: path.join(dir, 'scripts'),
    runsDir: path.join(dir, 'runs'),
    tmpDir: path.join(dir, 'tmp'),
    ledgerJson: path.join(dir, 'ledger.json'),
    ledgerFile: path.resolve(root, String(options.ledgerFile ?? DEFAULTS.ledgerFile)),
  }
}

/**
 * 兼容三种调用：{paths}、{cwd}、{cwd, paths}。
 * 给了 paths 就以它为准，缺的键从默认解析补齐（不重复算，也不抛错）。
 */
function ledgerPaths({ cwd, paths } = {}) {
  const root = paths?.root
    ? path.resolve(paths.root)
    : cwd
      ? path.resolve(cwd)
      : process.cwd()
  let base
  if (paths && typeof paths === 'object' && paths.ledgerJson) {
    base = { ...fallbackPaths(root), ...paths }
  } else {
    try {
      base = { ...resolvePaths(root, DEFAULTS), ...(paths ?? {}) }
    } catch {
      base = { ...fallbackPaths(root), ...(paths ?? {}) }
    }
  }
  const dir = base.dir ? path.resolve(base.dir) : path.join(root, '.probe')
  return {
    ...base,
    root,
    dir,
    ledgerJson: base.ledgerJson ? path.resolve(base.ledgerJson) : path.join(dir, 'ledger.json'),
    ledgerFile: base.ledgerFile ? path.resolve(base.ledgerFile) : path.join(root, 'PROBE.md'),
  }
}

function readLedger(ledgerJson) {
  const value = readJson(ledgerJson, [])
  if (!Array.isArray(value)) return []
  return value.filter((item) => isPlainObject(item))
}

/** Q-1、Q-2……：条数 + 1，撞上了就继续加。 */
function nextLedgerId(items) {
  const used = new Set(items.map((item) => String(item?.id ?? '')))
  let n = items.length + 1
  while (used.has(`Q-${n}`)) n += 1
  return `Q-${n}`
}

// ---------------------------------------------------------------------------
// 字段清洗
// ---------------------------------------------------------------------------

function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 单行化：账本每节是一个 markdown 列表，内部换行会破坏结构。 */
function oneLine(value) {
  return asText(value).replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// PROBE.md
// ---------------------------------------------------------------------------

function sectionText(entry) {
  const lines = [
    `## ${entry.id} · ${entry.question}`,
    `- 结论：${entry.verdict}`,
    `- 方法：${entry.method || '（未记录）'}`,
    `- 发现：${entry.findings || '（未记录）'}`,
    `- 备注：${entry.notes || '—'}`,
    `- 时间：${entry.at}`,
  ]
  return `${lines.join('\n')}\n`
}

function appendSection(file, entry) {
  const current = readText(file)
  const section = sectionText(entry)
  if (current === null || current.trim() === '') {
    writeText(file, `${LEDGER_TITLE}\n\n${LEDGER_INTRO}\n\n${section}`)
    return
  }
  writeText(file, `${current.replace(/\s+$/, '')}\n\n${section}`)
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 追加一条账本记录：写 .probe/ledger.json（数组）并在 PROBE.md 末尾加一节。
 * @returns {{id:string, file:string, entry:object}}
 */
export function appendLedger({ cwd, paths } = {}, entry = {}) {
  const resolved = ledgerPaths({ cwd, paths })
  const input = entry && typeof entry === 'object' ? entry : {}
  const question = oneLine(input.question)
  if (question === '') throw new Error('question 不能为空：先写清这次想弄清什么')

  const items = readLedger(resolved.ledgerJson)
  const record = {
    id: nextLedgerId(items),
    question,
    method: oneLine(input.method),
    findings: oneLine(input.findings),
    verdict: oneOf(input.verdict, VERDICTS, 'inconclusive', 'verdict'),
    notes: oneLine(input.notes),
    at: nowIso(),
  }

  items.push(record)
  writeJson(resolved.ledgerJson, items)
  appendSection(resolved.ledgerFile, record)

  return { id: record.id, file: relPosix(resolved.root, resolved.ledgerFile), entry: record }
}

/** 最近 limit 条，最新在前。 */
export function listLedger({ cwd, paths } = {}, { limit } = {}) {
  const resolved = ledgerPaths({ cwd, paths })
  const items = readLedger(resolved.ledgerJson)
  const max = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
  return { total: items.length, items: [...items].reverse().slice(0, max) }
}

/** 计数 + 最近一条。 */
export function ledgerSummary({ cwd, paths } = {}) {
  const resolved = ledgerPaths({ cwd, paths })
  const items = readLedger(resolved.ledgerJson)
  const byVerdict = { explained: 0, refuted: 0, inconclusive: 0 }
  for (const item of items) {
    const verdict = String(item?.verdict ?? 'inconclusive')
    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1
  }
  return {
    total: items.length,
    byVerdict,
    last: items.length > 0 ? items[items.length - 1] : null,
  }
}
