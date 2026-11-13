// dsh-probe — 临时探针脚本（建/看/列/删）。契约见 CONTRACT.md（模块契约 → lib/scripts.js）。
// 脚本都是临时资产：落在 .probe/scripts/ 下，probe_clean 会整片删掉。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { probePaths } from './store.js'
import { stampNow } from './runner.js'
import { ensureDir, nowIso, readText, relPosix, slugify, toAbs, writeText } from './util.js'

/** 支持的脚本 runtime；'auto' 按文件名后缀猜。 */
export const RUNTIMES = ['node', 'python', 'powershell']
export const RUNTIME_EXT = { node: '.mjs', python: '.py', powershell: '.ps1' }

/** 生成脚本里的名字占位符（用 split/join 替换，避免 $ 之类被当成替换模式）。 */
const NAME_TOKEN = '__NAME__'

const NODE_TEMPLATE = [
  '// dsh-probe script: __NAME__（临时；probe_clean 会删除）',
  '// 用法：node .probe/scripts/__NAME__.mjs --foo 1 --bar=baz',
  '// 约定：以 [probe] 开头的行会被 probe_run 单独摘进 probeLines。',
  'const argv = process.argv.slice(2)',
  '',
  '/** 极简 --key value / --flag / --key=value 解析，够探针用。 */',
  'function parseArgs(list) {',
  '  const out = { _: [] }',
  '  for (let i = 0; i < list.length; i += 1) {',
  '    const item = list[i]',
  "    if (!item.startsWith('--')) { out._.push(item); continue }",
  "    const eq = item.indexOf('=')",
  '    if (eq !== -1) { out[item.slice(2, eq)] = item.slice(eq + 1); continue }',
  '    const key = item.slice(2)',
  '    const next = list[i + 1]',
  "    if (next === undefined || next.startsWith('--')) out[key] = true",
  '    else { out[key] = next; i += 1 }',
  '  }',
  '  return out',
  '}',
  '',
  'const args = parseArgs(argv)',
  '',
  "console.log('[probe] script=__NAME__')",
  "console.log('[probe] runtime=node ' + process.version)",
  "console.log('[probe] argv=' + JSON.stringify(argv))",
  "console.log('[probe] args=' + JSON.stringify(args))",
  "console.log('[probe] pid=' + process.pid + ' cwd=' + process.cwd())",
  '// 换成你这轮真正想看的检查，例如：console.log(...)',
  "console.log('[probe] ok')",
  '',
].join('\n')

const PYTHON_TEMPLATE = [
  '# dsh-probe script: __NAME__（临时；probe_clean 会删除）',
  '# 用法：python .probe/scripts/__NAME__.py --foo 1 --bar=baz',
  '# 约定：以 [probe] 开头的行会被 probe_run 单独摘进 probeLines。',
  'import json',
  'import os',
  'import sys',
  '',
  'argv = sys.argv[1:]',
  '',
  '',
  'def parse_args(items):',
  '    """极简 --key value / --flag / --key=value 解析，够探针用。"""',
  '    out = {"_": []}',
  '    i = 0',
  '    while i < len(items):',
  '        item = items[i]',
  '        if not item.startswith("--"):',
  '            out["_"].append(item)',
  '        elif "=" in item:',
  '            key, _, value = item[2:].partition("=")',
  '            out[key] = value',
  '        else:',
  '            key = item[2:]',
  '            nxt = items[i + 1] if i + 1 < len(items) else None',
  '            if nxt is None or nxt.startswith("--"):',
  '                out[key] = True',
  '            else:',
  '                out[key] = nxt',
  '                i += 1',
  '        i += 1',
  '    return out',
  '',
  '',
  'args = parse_args(argv)',
  '',
  "print('[probe] script=__NAME__')",
  "print('[probe] runtime=python ' + sys.version.split()[0])",
  "print('[probe] argv=' + json.dumps(argv, ensure_ascii=False))",
  "print('[probe] args=' + json.dumps(args, ensure_ascii=False))",
  "print('[probe] pid=' + str(os.getpid()) + ' cwd=' + os.getcwd())",
  '# 换成你这轮真正想看的检查，例如：print(...)',
  "print('[probe] ok')",
  '',
].join('\n')

const POWERSHELL_TEMPLATE = [
  '# dsh-probe script: __NAME__（临时；probe_clean 会删除）',
  '# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .probe/scripts/__NAME__.ps1 --foo 1',
  '# 约定：以 [probe] 开头的行会被 probe_run 单独摘进 probeLines。',
  'param([Parameter(ValueFromRemainingArguments=$true)]$Rest)',
  '',
  "$ErrorActionPreference = 'Stop'",
  '$argv = @($Rest)',
  '',
  '# 极简 --key value / --flag / --key=value 解析，够探针用。',
  '$parsed = @{}',
  '$positional = @()',
  'for ($i = 0; $i -lt $argv.Count; $i++) {',
  '  $item = [string]$argv[$i]',
  "  if (-not $item.StartsWith('--')) { $positional += $item; continue }",
  "  if ($item.Contains('=')) {",
  "    $pair = $item.Substring(2).Split('=', 2)",
  '    $parsed[$pair[0]] = $pair[1]',
  '  } else {',
  '    $key = $item.Substring(2)',
  '    $next = if ($i + 1 -lt $argv.Count) { [string]$argv[$i + 1] } else { $null }',
  "    if ($null -eq $next -or $next.StartsWith('--')) { $parsed[$key] = $true }",
  '    else { $parsed[$key] = $next; $i++ }',
  '  }',
  '}',
  '',
  "Write-Output '[probe] script=__NAME__'",
  "Write-Output ('[probe] runtime=powershell ' + $PSVersionTable.PSVersion)",
  "Write-Output ('[probe] argv=' + ($argv -join ' '))",
  "Write-Output ('[probe] args=' + ($parsed | ConvertTo-Json -Compress))",
  "Write-Output ('[probe] pid=' + $PID + ' cwd=' + $PWD.Path)",
  '# 换成你这轮真正想看的检查，例如：Write-Output (...)',
  "Write-Output '[probe] ok'",
  '',
].join('\n')

const TEMPLATES = { node: NODE_TEMPLATE, python: PYTHON_TEMPLATE, powershell: POWERSHELL_TEMPLATE }

function fillTemplate(kind, name) {
  return TEMPLATES[kind].split(NAME_TOKEN).join(name)
}

const requireFrom = createRequire(import.meta.url)
// 与 CONTRACT.md 里「通用检测正则」保持一致（T1 已去掉 \b：> 是非单词字符，原版匹配不到）。
const FALLBACK_MARKER_RE = /(>>>|<<<)\s+dsh-probe\s+(begin|end)\s+(p[\w-]+)/i
let markersModule

/**
 * 文本里是否残留探针标记。优先用 lib/markers.js 的 hasMarkers（T1 实现），
 * 该模块还没到位时退回 CONTRACT.md 里定义的同一个 MARKER_RE。
 */
export function hasMarkers(text) {
  if (typeof text !== 'string' || text === '') return false
  if (markersModule === undefined) {
    try {
      markersModule = requireFrom('./markers.js')
    } catch {
      markersModule = null
    }
  }
  if (markersModule && typeof markersModule.hasMarkers === 'function') {
    try {
      return Boolean(markersModule.hasMarkers(text))
    } catch {
      // 落到下面的正则兜底。
    }
  }
  return FALLBACK_MARKER_RE.test(text)
}

function resolveRoot({ cwd, session, paths }) {
  if (paths && typeof paths.root === 'string' && paths.root !== '') return paths.root
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd)
  if (session && typeof session.cwd === 'string' && session.cwd.trim() !== '') return path.resolve(session.cwd)
  return process.cwd()
}

function resolveDirs({ cwd, session, paths }) {
  if (paths && typeof paths.scriptsDir === 'string') return paths
  return probePaths(resolveRoot({ cwd, session, paths }))
}

function cleanName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('脚本名不能为空（例：name="check"）。')
  const trimmed = name.trim()
  if (/[\\/:*?"<>|\r\n\t]/.test(trimmed)) {
    throw new Error(`脚本名不能含路径分隔符或特殊字符：${JSON.stringify(trimmed)}`)
  }
  if (trimmed.startsWith('.') || trimmed.includes('..')) {
    throw new Error(`脚本名不能以 . 开头，也不能含 ..：${JSON.stringify(trimmed)}`)
  }
  return trimmed
}

function guessRuntime(name) {
  const lower = String(name).toLowerCase()
  if (/\.(py|python)$/.test(lower)) return 'python'
  if (/\.(ps1|powershell)$/.test(lower)) return 'powershell'
  return 'node'
}

/** 'check.py' → 'check'；'run-check' → 'run-check'。落盘一律 slugify 后的短名。 */
function baseName(name) {
  const stripped = String(name).replace(/\.(mjs|cjs|js|ts|py|ps1)$/i, '')
  if (stripped.trim() === '') return 'script'
  return slugify(stripped)
}

function findEntry(session, name) {
  const scripts = Array.isArray(session?.scripts) ? session.scripts : []
  return { scripts, entry: scripts.find((item) => item && item.name === name) ?? null }
}

/**
 * 建一个临时探针脚本：写文件 + 登记进 session.scripts（同名替换）。
 * 已存在且没 force → 报错；有 force → 先备份到 .probe/tmp/ 再覆盖。
 * @returns {Promise<{script:object, file:string, created:boolean, backup:string|null}>}
 */
export async function createScript({ cwd, session, name, runtime, body, force = false, paths } = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('缺少探针会话：先调用 probe_begin 开一次会话。')
  }
  const scriptName = cleanName(name)
  const requested = runtime === undefined || runtime === null || String(runtime).trim() === ''
    ? 'auto'
    : String(runtime).trim().toLowerCase()
  const kind = requested === 'auto' ? guessRuntime(scriptName) : requested
  if (!RUNTIMES.includes(kind)) {
    throw new Error(`runtime 只能是 ${RUNTIMES.join(' | ')} | auto，收到 ${JSON.stringify(runtime)}`)
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new Error('脚本内容（body）必须是字符串')
  }

  const dirs = resolveDirs({ cwd, session, paths })
  const root = typeof dirs.root === 'string' ? dirs.root : resolveRoot({ cwd, session, paths })
  const ext = RUNTIME_EXT[kind]
  const file = path.join(dirs.scriptsDir, `${baseName(scriptName)}${ext}`)
  const rel = relPosix(root, file)

  const existing = readText(file)
  if (existing !== null && force !== true) {
    throw new Error(`探针脚本已存在：${rel}。要覆盖请传 force=true（覆盖前会备份到 .probe/tmp/）。`)
  }

  let backup = null
  if (existing !== null) {
    ensureDir(dirs.tmpDir)
    const bakAbs = path.join(dirs.tmpDir, `${path.basename(file)}.bak-${stampNow()}`)
    writeText(bakAbs, existing)
    backup = relPosix(root, bakAbs)
  }

  const text = typeof body === 'string' && body.trim() !== '' ? body : fillTemplate(kind, scriptName)
  ensureDir(dirs.scriptsDir)
  writeText(file, text)

  const { scripts, entry: previous } = findEntry(session, scriptName)
  // 同名换了 runtime：旧文件留着就是垃圾，顺手删掉（只在 .probe/scripts/ 内动手）。
  if (previous && previous.file && previous.file !== rel) {
    const oldAbs = toAbs(root, String(previous.file))
    if (path.dirname(oldAbs) === path.resolve(dirs.scriptsDir)) {
      try { fs.unlinkSync(oldAbs) } catch { /* 已经不在了 */ }
    }
  }

  const script = {
    name: scriptName,
    runtime: kind,
    file: rel,
    createdAt: previous?.createdAt ?? nowIso(),
  }
  if (previous) scripts[scripts.indexOf(previous)] = script
  else scripts.push(script)
  session.scripts = scripts

  return { script, file: rel, created: existing === null, backup }
}

/**
 * 以 session.scripts 为准列出脚本，只返回磁盘上还活着的。
 * markers 表示脚本源码里是否残留 dsh-probe 探针标记。
 */
export function listScripts({ cwd, session, paths } = {}) {
  const root = resolveRoot({ cwd, session, paths })
  const scripts = Array.isArray(session?.scripts) ? session.scripts : []
  const out = []
  for (const item of scripts) {
    if (!item || typeof item.name !== 'string' || typeof item.file !== 'string' || item.file === '') continue
    const abs = toAbs(root, item.file)
    const text = readText(abs)
    if (text === null) continue
    out.push({
      name: item.name,
      runtime: item.runtime,
      file: relPosix(root, abs),
      bytes: Buffer.byteLength(text, 'utf8'),
      markers: hasMarkers(text),
    })
  }
  return out
}

/** 看一个脚本的全文。没登记 / 文件丢了都报错。 */
export function showScript({ cwd, session, name, paths } = {}) {
  const scriptName = cleanName(name)
  const { entry } = findEntry(session, scriptName)
  if (!entry) {
    throw new Error(`没有登记名为 ${scriptName} 的探针脚本（用 probe_script action=list 看看现有脚本）。`)
  }
  const root = resolveRoot({ cwd, session, paths })
  const abs = toAbs(root, String(entry.file ?? ''))
  const text = readText(abs)
  if (text === null) {
    throw new Error(`探针脚本文件不见了：${entry.file}。用 probe_script action=new 重建。`)
  }
  return { name: entry.name, runtime: entry.runtime, file: relPosix(root, abs), text }
}

/** 删磁盘文件 + 从 session.scripts 摘除。没登记就报错。 */
export function removeScript({ cwd, session, name, paths } = {}) {
  const scriptName = cleanName(name)
  const { scripts, entry } = findEntry(session, scriptName)
  if (!entry) {
    throw new Error(`没有登记名为 ${scriptName} 的探针脚本（用 probe_script action=list 看看现有脚本）。`)
  }
  const root = resolveRoot({ cwd, session, paths })
  const abs = toAbs(root, String(entry.file ?? ''))
  let deleted = false
  try {
    fs.unlinkSync(abs)
    deleted = true
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  scripts.splice(scripts.indexOf(entry), 1)
  session.scripts = scripts
  return { name: entry.name, runtime: entry.runtime, file: entry.file, deleted }
}
