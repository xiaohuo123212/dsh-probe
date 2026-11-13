// dsh-probe — 通用小工具。只用 node: 内置模块，不依赖任何 Harness 包。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readText(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function tmpName(file) {
  const rand = crypto.randomBytes(6).toString('hex')
  return `${file}.tmp-${process.pid}-${rand}`
}

/** 原子写：先写同目录临时文件再 rename，避免半截文件。永远 UTF-8 无 BOM。 */
export function writeText(file, text) {
  ensureDir(path.dirname(file))
  const tmp = tmpName(file)
  fs.writeFileSync(tmp, text, { encoding: 'utf8' })
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return file
}

export function readJson(file, fallback) {
  const text = readText(file)
  if (text === null || text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function sha256(input) {
  return crypto.createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

/** 'pr-20261113-0127-ab12' */
export function makeId(prefix) {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = crypto.randomBytes(2).toString('hex')
  return `${prefix}-${stamp}-${rand}`
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function insidePath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function toAbs(base, p) {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p)
}

export function relPosix(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/')
}

export function slugify(s) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'run').slice(0, 40)
}

export function tailText(text, maxLines = 40, maxChars = 8000) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split(/\r?\n/)
  let out = lines.length > maxLines ? `... (${lines.length - maxLines} lines omitted)\n${lines.slice(-maxLines).join('\n')}` : text
  if (out.length > maxChars) out = `... (${out.length - maxChars} chars omitted)\n${out.slice(-maxChars)}`
  return out
}

export function jsonSafe(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === undefined) return undefined
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'function') return undefined
    if (v instanceof Error) return { name: v.name, message: v.message }
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined)
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      const next = walk(val)
      if (next !== undefined) out[k] = next
    }
    return out
  }
  return walk(value)
}

export function lineCount(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

export function sortKeys(obj) {
  if (!isPlainObject(obj)) return obj
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

/** 保留原文换行风格：返回 {eol, lines}，lines 不含换行符。 */
export function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  return { eol, lines }
}

export function joinLines(lines, eol) {
  return lines.join(eol)
}
