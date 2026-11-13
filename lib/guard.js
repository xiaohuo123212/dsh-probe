// dsh-probe — 残留探针守卫：找标记、判干净。契约见 CONTRACT.md。
//
// 命中判定只认通用检测正则 MARKER_RE（`>>>`/`<<<` + `dsh-probe` + `begin|end` + id），
// 所以普通文字里出现的 "dsh-probe" 不算命中（插件自己的文档会提到它）。
//
// 误报策略（与 CONTRACT.md「guardScan」一节一致）：
//   - 跳过整个 `.probe/`（会话/基线/运行记录里会抄到探针源码与标记样例）；
//   - 跳过项目根的 `CONTRACT.md`（契约文档自带标记格式示例）；
//   - 其余文件照扫，包括 README.md / skill/ —— 宁可让作者把示例写进 CONTRACT.md，
//     也不静默跳过用户项目里真正叫 docs/ 的代码目录。
// 该策略在返回值里不新增字段，通过 GUARD_SKIP_NOTE 交给上层写进 summary。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULTS, oneOf, resolvePaths } from './project.js'
import { insidePath, readText, relPosix } from './util.js'
import { MARKER_RE } from './markers.js'

/** scope 取值。 */
export const SCOPES = ['worktree', 'staged', 'all']

/** 给上层 summary 用的一句话，说明白扫了什么、没扫什么。 */
export const GUARD_SKIP_NOTE =
  '扫描范围说明：按策略跳过 .probe/ 整个目录与项目根的 CONTRACT.md（这两处自带标记示例，不算残留），其余文件照扫。'

const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git'])
const SKIP_ROOT_FILES = new Set(['contract.md'])
const GIT_TIMEOUT_MS = 20000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// 标记匹配
// ---------------------------------------------------------------------------

/** MARKER_RE 可能不带 g（契约里是没有的），扫描时用一份 global 副本，不改别人的常量。 */
function globalRe(source, flags) {
  return new RegExp(source, flags.includes('g') ? flags : `${flags}g`)
}

function markerSource() {
  return typeof MARKER_RE?.source === 'string' ? MARKER_RE.source : String(MARKER_RE)
}

function markerFlags() {
  return typeof MARKER_RE?.flags === 'string' ? MARKER_RE.flags : ''
}

const SCAN_RE = globalRe(markerSource(), markerFlags())

// 契约里的 MARKER_RE 以 `\b(>>>|<<<)` 开头，但实际标记行是 `// >>> dsh-probe begin p1`：
// `/` 和 `>` 都是非单词字符，两者之间没有单词边界，所以按原样永远匹配不到契约自己定义的标记格式
// （`# >>>`、`<!-- >>>`、`rem >>>` 同理，只有 `x>>>` 这种才碰巧过）。
// 这里以 MARKER_RE 为主，匹配不到时再用「去掉开头的 \b」的同一正则兜底，两种实现都能工作。
const LOOSE_SOURCE = markerSource().startsWith('\\b') ? markerSource().slice(2) : null
const LOOSE_RE = LOOSE_SOURCE === null ? null : globalRe(LOOSE_SOURCE, markerFlags())
const FALLBACK_RE = LOOSE_SOURCE === null ? null : new RegExp(LOOSE_SOURCE, 'i')

/**
 * 从一次 regex 命中里取出 type/id。以契约的分组顺序 (1 arrow, 2 type, 3 id) 为准，
 * 分组缺失时才回退到按命中文本重新解析，避免别的模块微调正则在 guard 这里炸掉。
 */
function markerInfo(match) {
  let type = match?.[2]
  let id = match?.[3]
  if (!/^(begin|end)$/i.test(String(type ?? '')) || !/^p[\w-]+$/i.test(String(id ?? ''))) {
    const parsed = FALLBACK_RE === null ? null : FALLBACK_RE.exec(String(match?.[0] ?? ''))
    if (parsed) {
      type = parsed[2]
      id = parsed[3]
    }
  }
  return {
    type: String(type ?? '').toLowerCase(),
    id: String(id ?? ''),
  }
}

/** 一行里所有标记（同一 id 只算一次）。 */
function markersOnLine(line) {
  if (typeof line !== 'string' || !line.includes('dsh-probe')) return []
  const out = []
  const seen = new Set()
  for (const regexp of [SCAN_RE, LOOSE_RE]) {
    if (!regexp) continue
    regexp.lastIndex = 0
    for (const match of line.matchAll(regexp)) {
      const info = markerInfo(match)
      if (!info.id || seen.has(info.id)) continue
      seen.add(info.id)
      out.push(info)
    }
    if (out.length > 0) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 路径过滤
// ---------------------------------------------------------------------------

function toExcludeEntry(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** 把任意来源的相对路径规整成正斜杠相对路径；绝对路径/穿越/空串 → null。 */
function normalizeRel(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (cleaned === '') return null
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return null
  const parts = cleaned.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return cleaned
}

/**
 * 返回跳过原因；null 表示要扫。
 * reason: 'always' | 'probe' | 'exclude' | 'contract'
 */
function makeSkipFilter({ exclude, dataDirRel }) {
  const excluded = (Array.isArray(exclude) ? exclude : []).map(toExcludeEntry).filter(Boolean)
  const dataDir = toExcludeEntry(dataDirRel)
  return function skipReason(rel, isDir) {
    const lower = rel.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    // .probe/ 整个目录（含 git 列出的是单个文件的情况）一律不看
    if (dataDir !== '' && (lower === dataDir || lower.startsWith(`${dataDir}/`))) return 'probe'
    if (isDir) {
      if (ALWAYS_SKIP_DIRS.has(name)) return 'always'
    } else if (ALWAYS_SKIP_DIRS.has(name)) {
      // 同名文件（比如误命名的 .git 文件）也跳过
      return 'always'
    }
    if (!isDir && !lower.includes('/') && SKIP_ROOT_FILES.has(lower)) return 'contract'
    for (const entry of excluded) {
      if (entry.includes('/')) {
        if (lower === entry || lower.startsWith(`${entry}/`)) return 'exclude'
      } else if (name === entry || lower.split('/').includes(entry)) {
        return 'exclude'
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitRun(root, args) {
  let result
  try {
    result = spawnSync('git', ['-C', root, ...args], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    })
  } catch {
    return null
  }
  if (!result || result.error) return null
  if (result.status !== 0) return null
  return typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '')
}

function isGitRepo(root) {
  const out = gitRun(root, ['rev-parse', '--is-inside-work-tree'])
  return out !== null && out.trim() === 'true'
}

/** -z 输出按 NUL 切；git 的 -z 不做引号转义。 */
function splitZ(out) {
  return out
    .split('\0')
    .map((item) => item.replace(/\r$/, '').trim())
    .filter(Boolean)
}

function gitLsFiles(root, scope) {
  const cached = () => gitRun(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const staged = () => gitRun(root, ['diff', '--cached', '--name-only', '-z'])
  if (scope === 'staged') return staged()
  const worktree = cached()
  if (worktree === null) return null
  if (scope === 'worktree') return worktree
  const stagedOut = staged()
  if (stagedOut === null) return worktree
  return worktree + stagedOut
}

// ---------------------------------------------------------------------------
// 遍历（非 git 降级）
// ---------------------------------------------------------------------------

function walkFiles(root, skipReason) {
  const out = []
  const stack = ['']
  const seenDirs = new Set()
  while (stack.length > 0) {
    const relDir = stack.pop()
    const absDir = relDir === '' ? root : path.join(root, relDir)
    if (seenDirs.has(absDir)) continue
    seenDirs.add(absDir)
    let entries
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        // 符号链接不跟：避免环，也避免跑到项目外。
        isDir = false
        isFile = false
      }
      if (isDir) {
        if (skipReason(rel, true)) continue
        stack.push(rel)
      } else if (isFile) {
        if (skipReason(rel, false)) continue
        out.push(rel)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 读文件
// ---------------------------------------------------------------------------

/** → { text, reason }；text 为 null 表示跳过，reason 说明原因。 */
function readScannable(abs, maxBytes) {
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    return { text: null, reason: 'missing' }
  }
  if (!stat.isFile()) return { text: null, reason: 'notfile' }
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULTS.maxScanBytes
  if (stat.size > limit) return { text: null, reason: 'size' }
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    return { text: null, reason: 'unreadable' }
  }
  if (buf.length > limit) return { text: null, reason: 'size' }
  if (buf.length === 0) return { text: '', reason: null }
  if (buf.includes(0)) return { text: null, reason: 'binary' }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, reason: null }
}

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

function mergeOptions(options) {
  const merged = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  if (!Array.isArray(merged.exclude)) merged.exclude = [...DEFAULTS.exclude]
  return merged
}

/** paths 由调用方给就用，否则自己算；算不出来（配置非法）不抛错，退化成默认路径。 */
function resolvePathsSafe(root, paths, options) {
  if (paths && typeof paths === 'object' && paths.dir) return paths
  try {
    return resolvePaths(root, options)
  } catch {
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
}

function sortOffenders(offenders) {
  return offenders.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
}

// ---------------------------------------------------------------------------
// guardScan
// ---------------------------------------------------------------------------

/**
 * 扫项目里的残留探针标记。
 * @returns {Promise<{ok:boolean, offenders:Array<{file:string,line:number,text:string,id:string}>,
 *   trackedProbeDir:boolean, scannedFiles:number, warnings:string[]}>}
 */
export async function guardScan({ cwd, scope, paths, options } = {}) {
  const root = path.resolve(cwd ?? process.cwd())
  const opts = mergeOptions(options)
  const scopeValue = oneOf(scope, SCOPES, 'worktree', 'scope')
  const resolved = resolvePathsSafe(root, paths, opts)
  const dataDirRel = normalizeRel(relPosix(root, resolved.dir)) ?? '.probe'
  const skipReason = makeSkipFilter({ exclude: opts.exclude, dataDirRel })

  const warnings = []
  const repo = isGitRepo(root)

  let rawList = null
  if (repo) {
    rawList = gitLsFiles(root, scopeValue)
    if (rawList === null) warnings.push('读取 git 文件清单失败，已降级为遍历目录扫描')
  } else {
    warnings.push('当前目录不是 git 仓库（或没有 git），已降级为遍历目录扫描')
  }

  const files = new Set()
  if (rawList !== null) {
    for (const item of splitZ(rawList)) {
      const rel = normalizeRel(item)
      if (!rel) continue
      if (skipReason(rel, false)) continue
      files.add(rel)
    }
  } else {
    for (const rel of walkFiles(root, skipReason)) files.add(rel)
  }

  const maxScanBytes = Number.isFinite(opts.maxScanBytes) ? opts.maxScanBytes : DEFAULTS.maxScanBytes
  const offenders = []
  const seenHits = new Set()
  let scannedFiles = 0
  let tooBig = 0

  for (const rel of files) {
    const abs = path.join(root, rel)
    const { text, reason } = readScannable(abs, maxScanBytes)
    if (text === null) {
      if (reason === 'size') tooBig += 1
      continue
    }
    scannedFiles += 1
    if (text === '') continue
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const markers = markersOnLine(line)
      if (markers.length === 0) continue
      const lineNo = index + 1
      const key = `${rel}:${lineNo}`
      if (seenHits.has(key)) continue
      seenHits.add(key)
      offenders.push({ file: rel, line: lineNo, text: line.trim(), id: markers[0].id })
    }
  }

  if (tooBig > 0) {
    warnings.push(`已跳过 ${tooBig} 个超过 maxScanBytes（${maxScanBytes} 字节）的文件，需要的话调大 options.maxScanBytes`)
  }

  let trackedProbeDir = false
  if (repo) {
    const out = gitRun(root, ['ls-files', '-z', '--', dataDirRel])
    trackedProbeDir = out !== null && splitZ(out).length > 0
    if (trackedProbeDir) {
      warnings.push(`${dataDirRel}/ 里有被 git 跟踪的文件，建议把 ${dataDirRel}/ 加进 .gitignore（探针目录本来就不该进版本库）`)
    }
  }

  sortOffenders(offenders)
  return { ok: offenders.length === 0, offenders, trackedProbeDir, scannedFiles, warnings }
}

// ---------------------------------------------------------------------------
// residualScan
// ---------------------------------------------------------------------------

/**
 * 只看这次会话动过的文件，复核残留标记（probe_clean 之后用）。
 * @returns {Promise<{ok:boolean, offenders:Array<{file:string,line:number,text:string,id:string}>,
 *   missingFiles:string[]}>}
 */
export async function residualScan({ cwd, session } = {}) {
  const root = path.resolve(cwd ?? process.cwd())
  const probes = Array.isArray(session?.probes) ? session.probes : []
  const wanted = []
  const seenFiles = new Set()
  for (const probe of probes) {
    const rel = normalizeRel(probe?.file)
    if (!rel || seenFiles.has(rel)) continue
    seenFiles.add(rel)
    wanted.push(rel)
  }

  const offenders = []
  const missingFiles = []
  const seenHits = new Set()

  for (const rel of wanted) {
    const abs = path.resolve(root, rel)
    if (!insidePath(root, abs)) {
      missingFiles.push(rel)
      continue
    }
    const text = readText(abs)
    if (text === null) {
      missingFiles.push(rel)
      continue
    }
    if (text === '') continue
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const markers = markersOnLine(line)
      if (markers.length === 0) continue
      const lineNo = index + 1
      const key = `${rel}:${lineNo}`
      if (seenHits.has(key)) continue
      seenHits.add(key)
      offenders.push({ file: rel, line: lineNo, text: line.trim(), id: markers[0].id })
    }
  }

  sortOffenders(offenders)
  return { ok: offenders.length === 0, offenders, missingFiles }
}
