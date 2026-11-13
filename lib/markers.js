// dsh-probe — 探针标记的生成与解析。契约见 CONTRACT.md「标记格式」「lib/markers.js」。
// 标记是语言无关的载荷，只靠注释符包起来；检测只认载荷，不看注释符。
import path from 'node:path'

/**
 * 注释风格表。open 是注释开始符，close 只对块注释（block）有值。
 * 键名是契约的一部分（session.probes[].style 用它）。
 */
export const STYLES = {
  line: { open: '//', close: '' },
  hash: { open: '#', close: '' },
  dash: { open: '--', close: '' },
  semi: { open: ';', close: '' },
  rem: { open: 'rem', close: '' },
  pct: { open: '%', close: '' },
  quote: { open: "'", close: '' },
  block: { open: '<!--', close: '-->' },
}

/**
 * 通用检测正则（guard 扫描、clean 兜底都用它，忽略注释符）。
 * 注意：契约原文里的 `\b` 放在 `>>>` 前面永远不成立（`>` 是非单词字符，
 * 前面是空格时没有单词边界），所以这里去掉了 `\b`——只放宽、不放窄，向后兼容。
 */
export const MARKER_RE = /(>>>|<<<)\s+dsh-probe\s+(begin|end)\s+(p[\w-]+)/i

/** 扩展名 → STYLES 键。未知扩展名回落 'line'。 */
export const EXT_STYLE = {
  // // 行注释
  js: 'line', mjs: 'line', cjs: 'line', jsx: 'line', mts: 'line', cts: 'line',
  ts: 'line', tsx: 'line',
  c: 'line', h: 'line', cc: 'line', cpp: 'line', cxx: 'line', hpp: 'line', hh: 'line', hxx: 'line',
  cs: 'line', java: 'line', go: 'line', rs: 'line', kt: 'line', kts: 'line', swift: 'line',
  scala: 'line', dart: 'line', php: 'line', groovy: 'line', gradle: 'line', m: 'line', mm: 'line',
  zig: 'line', sol: 'line', proto: 'line', fs: 'line', fsx: 'line', as: 'line',
  // # 行注释
  py: 'hash', pyw: 'hash', pyi: 'hash',
  sh: 'hash', bash: 'hash', zsh: 'hash', ksh: 'hash', fish: 'hash',
  yaml: 'hash', yml: 'hash', rb: 'hash', rake: 'hash', pl: 'hash', pm: 'hash',
  toml: 'hash', r: 'hash', jl: 'hash', nim: 'hash',
  ps1: 'hash', psm1: 'hash', psd1: 'hash',
  env: 'hash', gitignore: 'hash', gitattributes: 'hash', dockerignore: 'hash',
  mk: 'hash', cmake: 'hash', tf: 'hash', tfvars: 'hash', hcl: 'hash',
  // <!-- --> 块注释
  html: 'block', htm: 'block', xhtml: 'block', vue: 'block', svelte: 'block', astro: 'block',
  xml: 'block', xsl: 'block', xslt: 'block', svg: 'block',
  md: 'block', markdown: 'block', mdx: 'block', hbs: 'block', handlebars: 'block',
  // -- 行注释
  lua: 'dash', sql: 'dash', hs: 'dash', lhs: 'dash', elm: 'dash', adb: 'dash', ads: 'dash',
  // ; 行注释
  ini: 'semi', cfg: 'semi', conf: 'semi', properties: 'semi', desktop: 'semi', editorconfig: 'semi',
  // rem 行注释
  bat: 'rem', cmd: 'rem',
  // % 行注释
  tex: 'pct', sty: 'pct', latex: 'pct',
  // ' 行注释
  vim: 'quote', vb: 'quote', vbs: 'quote', bas: 'quote',
}

/** 没有扩展名但家喻户晓的文件名。 */
const BASENAME_STYLE = {
  makefile: 'hash',
  gnumakefile: 'hash',
  dockerfile: 'hash',
  gemfile: 'hash',
  rakefile: 'hash',
  procfile: 'hash',
  jenkinsfile: 'hash',
  vagrantfile: 'hash',
  brewfile: 'hash',
  '.bashrc': 'hash',
  '.zshrc': 'hash',
  '.profile': 'hash',
  '.gitignore': 'hash',
  '.gitattributes': 'hash',
  '.npmrc': 'hash',
  '.env': 'hash',
}

/** 扩展名 → 风格键；未知扩展名回落 'line'（`//` 在未知文件里也安全）。 */
export function styleForFile(file) {
  const name = path.basename(String(file ?? '')).toLowerCase()
  if (!name) return 'line'
  if (BASENAME_STYLE[name]) return BASENAME_STYLE[name]
  const dot = name.lastIndexOf('.')
  if (dot >= 0) {
    const ext = name.slice(dot + 1)
    if (ext !== '' && EXT_STYLE[ext]) return EXT_STYLE[ext]
  }
  // 没扩展名时按文件名再兜一层（Makefile 之类大小写变体已被 toLowerCase 覆盖）。
  return 'line'
}

function styleEntry(style) {
  const key = String(style ?? '').toLowerCase()
  return STYLES[key] ?? STYLES.line
}

/** 风格对应的注释开始符（未知风格按 line 处理，返回 '//'）。 */
export function commentOpen(style) {
  return styleEntry(style).open
}

/** begin 行尾的说明文字：给人看，检测时忽略。 */
const MARKER_HINT = '(temporary; probe_clean removes this block)'

function markerLine(style, payload) {
  const entry = styleEntry(style)
  return entry.close ? `${entry.open} ${payload} ${entry.close}` : `${entry.open} ${payload}`
}

function cleanId(id) {
  const text = typeof id === 'string' ? id.trim() : String(id ?? '').trim()
  if (!/^p[\w-]+$/i.test(text)) {
    throw new Error(`探针 id 形状不对：${JSON.stringify(id)}（应为 p1、p2-1 这类，以 p 开头）`)
  }
  return text
}

function cleanLabel(label) {
  if (label === undefined || label === null) return ''
  return String(label)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/-->/g, '->') // 别让 label 提前关掉 block 注释
    .trim()
    .slice(0, 40)
}

/** 完整一行 begin 标记（含注释符与行尾说明）。 */
export function beginLine(style, id, label) {
  const tail = cleanLabel(label)
  const payload = `>>> dsh-probe begin ${cleanId(id)}${tail ? ` ${tail}` : ''}  ${MARKER_HINT}`
  return markerLine(style, payload)
}

/** 完整一行 end 标记。 */
export function endLine(style, id) {
  return markerLine(style, `<<< dsh-probe end ${cleanId(id)}`)
}

/** 一行一行切开，行内容不含换行符；末尾换行不会多出幻影行。 */
function lineTexts(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 找出所有标记。
 * @returns {{line:number,index:number,type:'begin'|'end',id:string,text:string}[]}
 *   line 是 1-based 行号，index 是行内 0-based 列偏移，text 是整行原文。
 */
export function findMarkers(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = lineTexts(text)
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('dsh-probe')) continue // 快速跳过绝大多数行
    const re = new RegExp(MARKER_RE.source, 'gi')
    let match
    while ((match = re.exec(line)) !== null) {
      found.push({
        line: i + 1,
        index: match.index,
        type: match[2].toLowerCase(),
        id: match[3],
        text: line,
      })
      if (match.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return found
}

/** 是否含标记。 */
export function hasMarkers(text) {
  return findMarkers(text).length > 0
}

/** 第一个标记所在行（1-based）；没有标记返回 0。 */
export function firstMarkerLine(text) {
  const markers = findMarkers(text)
  return markers.length > 0 ? markers[0].line : 0
}

function dropRange(drop, from, to, total) {
  const start = Math.max(1, from)
  const end = Math.min(total, to)
  for (let line = start; line <= end; line += 1) drop[line - 1] = true
}

/**
 * 去掉所有探针块，返回新文本与账目。
 * - 块内容整行删除，块外字节一个不动（逐行保留各自换行符，CRLF 不会被改成 LF）。
 * - 残块不抛错，进 residuals：有 begin 无 end / 有 end 无 begin / begin 与 end 的 id 不匹配。
 * - 结果幂等：连着调用两次，第二次没有可删的东西。
 * @returns {{text:string,removed:{id:string,startLine:number,endLine:number,lines:number}[],
 *            residuals:{line:number,id:string,type:'begin'|'end',reason:string}[]}}
 */
export function stripMarkers(text) {
  const source = typeof text === 'string' ? text : ''
  const removed = []
  const residuals = []
  if (source === '') return { text: source, removed, residuals }

  // 逐行切开，同时记住每行自己的换行符，重建时才能做到「块外一个字节都不改」。
  const lines = []
  const eols = []
  let cursor = 0
  const re = /\r\n|\n|\r/g
  let match
  while ((match = re.exec(source)) !== null) {
    lines.push(source.slice(cursor, match.index))
    eols.push(match[0])
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) {
    lines.push(source.slice(cursor))
    eols.push('')
  }
  const total = lines.length
  if (total === 0) return { text: source, removed, residuals }

  const markers = findMarkers(source)
  const drop = new Array(total).fill(false)
  if (markers.length === 0) return { text: source, removed, residuals }

  let open = null
  const closeBlock = (begin, end, reason, mismatch) => {
    const endLine = Math.max(begin.line, Math.min(end.line, total))
    dropRange(drop, begin.line, endLine, total)
    removed.push({
      id: begin.id,
      startLine: begin.line,
      endLine,
      lines: endLine - begin.line + 1,
    })
    if (reason) {
      residuals.push({ line: begin.line, id: begin.id, type: 'begin', reason })
      if (mismatch) residuals.push({ line: end.line, id: end.id, type: 'end', reason })
    }
  }

  for (const marker of markers) {
    if (marker.type === 'begin') {
      if (open) {
        // 上一个 begin 一直没等到 end：记残块，区间只算到本 begin 之前，
        // 这样后面那个完整块（以及块外代码）不会被一起吞掉。
        closeBlock(open, { line: marker.line - 1, id: open.id }, 'unclosed', false)
        open = null
      }
      open = marker
      continue
    }
    // marker.type === 'end'
    if (!open) {
      residuals.push({ line: marker.line, id: marker.id, type: 'end', reason: 'stray-end' })
      dropRange(drop, marker.line, marker.line, total) // 孤立的 end 行也是残留，删掉
      continue
    }
    if (open.id.toLowerCase() === marker.id.toLowerCase()) {
      closeBlock(open, marker, '', false)
    } else {
      closeBlock(open, marker, 'id-mismatch', true)
    }
    open = null
  }

  if (open) {
    // 没闭合的 begin：从这个 begin 一直算到文件末尾。
    const endLine = total
    dropRange(drop, open.line, endLine, total)
    removed.push({ id: open.id, startLine: open.line, endLine, lines: endLine - open.line + 1 })
    residuals.push({ line: open.line, id: open.id, type: 'begin', reason: 'unclosed' })
  }

  let out = ''
  for (let i = 0; i < total; i += 1) {
    if (drop[i]) continue
    out += lines[i] + eols[i]
  }
  return { text: out, removed, residuals }
}
