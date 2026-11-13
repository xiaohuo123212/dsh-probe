// dsh-probe — 把探针块插进源码的正确位置。契约见 CONTRACT.md「lib/insert.js」。
// 原则：先在内存里算好全部内容并完成校验，再落盘；写前拍基线。
import fs from 'node:fs'
import path from 'node:path'
import { insidePath, joinLines, nowIso, readText, relPosix, splitLines, toAbs, writeText } from './util.js'
import { nextProbeId, saveBaseline } from './store.js'
import { STYLES, beginLine, endLine, findMarkers, styleForFile } from './markers.js'

const POSITIONS = ['after', 'before']

/** 逐行切开（行内容不含换行符，末尾换行不产生幻影行），同时给出换行风格。 */
function scanText(text) {
  const { eol } = splitLines(text)
  const lines = []
  let cursor = 0
  const re = /\r\n|\n|\r/g
  let match
  while ((match = re.exec(text)) !== null) {
    lines.push(text.slice(cursor, match.index))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) lines.push(text.slice(cursor))
  const trailing = text === '' ? true : /[\r\n]$/.test(text)
  return { eol, lines, trailing }
}

function requireCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('缺少 cwd（项目根目录）；工具层没把工作目录传进来。')
  }
  return path.resolve(cwd)
}

function resolveFile(cwd, file) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('file 不能为空：要插到哪个文件？例如 src/server.js')
  }
  const abs = toAbs(cwd, file.trim())
  if (!insidePath(cwd, abs)) {
    throw new Error(`探针只能插在项目内：${relPosix(cwd, abs)} 跑到了 ${cwd} 外面。给相对项目根的路径。`)
  }
  return { abs, rel: relPosix(cwd, abs) }
}

/** 新建文件的骨架：一行注释头 + 一个空行。 */
function newFileText(style, rel) {
  const entry = STYLES[style] ?? STYLES.line
  const body = `dsh-probe: 新建的探针文件 ${rel}（临时，probe_clean 会清理）`
  const header = entry.close ? `${entry.open} ${body} ${entry.close}` : `${entry.open} ${body}`
  return `${header}\n\n`
}

/** 缩进选项 → 实际施加的缩进字符串。 */
function resolveIndentOption(indent) {
  if (indent === undefined || indent === null || indent === '') return 'anchor'
  if (typeof indent !== 'string') {
    throw new Error(`indent 只能是 'anchor' | 'none' | 缩进字符串，收到 ${JSON.stringify(indent)}`)
  }
  if (indent !== 'anchor' && indent !== 'none' && /[\r\n]/.test(indent)) {
    throw new Error("indent 只能是 'anchor' | 'none' 或只含空格/Tab 的字符串（不能带换行）")
  }
  return indent
}

function indentFor(option, targetLine) {
  if (option === 'none') return ''
  if (option === 'anchor') {
    const match = /^[\t ]*/.exec(typeof targetLine === 'string' ? targetLine : '')
    return match ? match[0] : ''
  }
  return option
}

function codeLines(code) {
  const raw = code.replace(/\r\n|\r/g, '\n').split('\n')
  while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop()
  return raw
}

function candidateLines(lines, indexes) {
  const max = 5
  const shown = indexes.slice(0, max).map((index) => {
    const content = lines[index].trim()
    const text = content.length > 100 ? `${content.slice(0, 100)}…` : content
    return `  ${index + 1}: ${text}`
  })
  if (indexes.length > max) shown.push(`  …还有 ${indexes.length - max} 处`)
  return shown.join('\n')
}

/**
 * 插入一个探针块。
 * @returns {Promise<{file:string, probe:object, summary:string}>}
 */
export async function insertProbe(options = {}) {
  const {
    cwd,
    session,
    file,
    code,
    anchor,
    line,
    position,
    label,
    indent,
    create,
  } = options ?? {}

  const root = requireCwd(cwd)
  if (!session || typeof session !== 'object' || !Array.isArray(session.probes)) {
    throw new Error('缺少探针会话；先调用 probe_begin 开一次（会在 .probe/ 下记账）。')
  }
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error('code 不能为空：要插什么代码？例如 console.log("[probe] dt", dt)')
  }
  if (/dsh-probe/i.test(code)) {
    throw new Error('code 里不能出现 dsh-probe 标记文本：会把标记配对搞坏，请先删掉那行注释。')
  }
  if (position !== undefined && position !== null && !POSITIONS.includes(position)) {
    throw new Error(`position 只能是 ${POSITIONS.join(' | ')}，收到 ${JSON.stringify(position)}`)
  }
  if (label !== undefined && label !== null && typeof label !== 'string') {
    throw new Error(`label 只能是字符串，收到 ${JSON.stringify(label)}`)
  }
  const indentOption = resolveIndentOption(indent)
  const { abs, rel } = resolveFile(root, file)
  const style = styleForFile(abs)

  let stat = null
  try {
    stat = fs.statSync(abs)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  if (stat && !stat.isFile()) {
    throw new Error(`这不是普通文件：${rel}（探针只能插进文件里）`)
  }

  let text = readText(abs)
  let created = false
  if (text === null) {
    if (create !== true) {
      throw new Error(`文件不存在：${rel}。想新建就传 create: true（会先写一行注释头再插探针）。`)
    }
    created = true
    text = newFileText(style, rel)
  }

  const fileText = text
  const { eol, lines, trailing } = scanText(fileText)

  // —— 定位：显式 line > anchor ——
  let at = 0 // 0-based 插入下标（插到 lines[at] 之前）
  let targetLine = ''
  const lineArg = line === undefined || line === null || line === '' ? undefined : line
  const anchorArg = typeof anchor === 'string' && anchor.trim() !== '' ? anchor : undefined

  if (lineArg !== undefined) {
    const wanted = typeof lineArg === 'number' ? lineArg : Number(lineArg)
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new Error(`line 要是 1-based 整数行号，收到 ${JSON.stringify(line)}。`)
    }
    const total = Math.max(1, lines.length)
    if (wanted > total) {
      throw new Error(`line ${wanted} 超出文件范围（${rel} 只有 ${lines.length} 行）。`)
    }
    const insertAt = position === 'before' ? wanted - 1 : wanted
    at = Math.min(Math.max(insertAt, 0), lines.length)
    targetLine = lines[wanted - 1] ?? ''
  } else if (anchorArg !== undefined) {
    const findIndexes = (needle) => {
      const hit = []
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(needle)) hit.push(i)
      }
      return hit
    }
    let indexes = findIndexes(anchorArg)
    if (indexes.length === 0 && anchorArg.trim() !== anchorArg) indexes = findIndexes(anchorArg.trim())
    if (indexes.length === 0) {
      throw new Error(`没找到 anchor：${JSON.stringify(anchorArg)}。检查空格/缩进是否和文件里一致，或直接给 line。`)
    }
    if (indexes.length > 1) {
      throw new Error(
        `anchor 匹配到 ${indexes.length} 行，无法确定插哪一行：\n${candidateLines(lines, indexes)}\n` +
          '请把 anchor 写长一点（带上前后文），或直接给 line。',
      )
    }
    at = indexes[0] + 1 // anchor 默认插在锚点行之后
    targetLine = lines[indexes[0]]
  } else if (created) {
    // 新建出来的文件只有注释头 + 空行，没有可锚定的行：直接追到末尾（换行会补齐）。
    at = lines.length
    targetLine = lines[lines.length - 1] ?? ''
  } else {
    throw new Error(
      '要给定位信息：line（1-based 行号，可用 position: after|before）或 anchor（文件里唯一的一行文本，插在它后面）。',
    )
  }

  // 同 id 的块已经在文件里（多半是上次会话残留）→ 先别写，免得把文件搞坏。
  const id = nextProbeId(session)
  const clash = findMarkers(fileText).filter((marker) => marker.id.toLowerCase() === id.toLowerCase())
  if (clash.length > 0) {
    throw new Error(
      `${rel} 里已经有 ${id} 的探针标记（第 ${clash.map((m) => m.line).join('、')} 行，多半是上次会话的残留）。` +
        '先 probe_clean 清理，或换一个文件。',
    )
  }

  const prefix = indentFor(indentOption, targetLine)
  const rawCode = codeLines(code)
  const body = rawCode.map((one) => (one.trim() === '' ? '' : `${prefix}${one}`))
  const block = [beginLine(style, id, label), ...body, endLine(style, id)]

  const out = [...lines.slice(0, at), ...block, ...lines.slice(at)]
  let nextText = joinLines(out, eol)
  if (trailing && out.length > 0) nextText += eol

  // 全部算完、校验通过，才开始写：先拍基线，再落盘。
  // 新建文件的基线取「刚写的注释头骨架」——clean 时剥掉探针块正好逐字节等于它，不会误报「其它行也被改过」。
  saveBaseline(root, session, rel, fileText)
  writeText(abs, nextText)

  const startLine = at + 1
  const endLineNo = at + block.length
  const probe = {
    id,
    file: rel,
    style,
    anchor: anchorArg ?? null,
    startLine,
    endLine: endLineNo,
    code: rawCode.join('\n'),
    indent: prefix,
    createdAt: nowIso(),
  }
  if (typeof label === 'string' && label.trim() !== '') probe.label = label.trim()
  if (created) probe.created = true
  session.probes.push(probe)

  const where = `第 ${startLine}–${endLineNo} 行`
  const summary = created
    ? `已新建 ${rel} 并插入探针 ${id}（${where}，${style} 注释，缩进 ${JSON.stringify(prefix)}）`
    : `已插入探针 ${id} → ${rel}（${where}，${style} 注释，缩进 ${JSON.stringify(prefix)}）`
  return { file: rel, probe, summary }
}

/**
 * 看一眼文件里的探针情况（不修改文件）。
 * @returns {Promise<{lines:number, markers:object[], probeIds:string[]}>}
 */
export async function inspectFile(options = {}) {
  const { cwd, file } = options ?? {}
  const root = requireCwd(cwd)
  const { abs, rel } = resolveFile(root, file)
  const text = readText(abs)
  if (text === null) {
    throw new Error(`文件不存在：${rel}（要新建就先 probe_insert 并传 create: true）`)
  }
  const markers = findMarkers(text)
  const probeIds = [...new Set(markers.map((marker) => marker.id))]
  const { lines } = scanText(text)
  return { lines: lines.length, markers, probeIds }
}
