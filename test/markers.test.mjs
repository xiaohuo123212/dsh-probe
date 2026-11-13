// T1 验收测试：lib/markers.js + lib/insert.js。node --test test/markers.test.mjs
// 一律在 os.tmpdir() 下建临时项目，结束删掉，不碰用户工作区。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  STYLES,
  MARKER_RE,
  EXT_STYLE,
  styleForFile,
  commentOpen,
  beginLine,
  endLine,
  findMarkers,
  hasMarkers,
  stripMarkers,
  firstMarkerLine,
} from '../lib/markers.js'
import { insertProbe, inspectFile } from '../lib/insert.js'
import { loadBaseline } from '../lib/store.js'

// —— 小工具 ——

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-t1-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeProjectFile(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
  return abs
}

function readProjectFile(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function makeSession(cwd) {
  return {
    version: 1,
    id: 'pr-test',
    label: 'T1',
    goal: '测试',
    startedAt: new Date().toISOString(),
    cwd,
    baseline: {},
    probes: [],
    scripts: [],
    runs: [],
  }
}

/** 按真实行切（末尾换行不产生幻影行），用来核对 probe.startLine/endLine。 */
function realLines(text) {
  const parts = text.split(/\r\n|\n|\r/)
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function assertProbeLines(text, probe) {
  const lines = realLines(text)
  assert.match(lines[probe.startLine - 1] ?? '', new RegExp(`>>> dsh-probe begin ${probe.id}\\b`), 'startLine 应该指向 begin 标记')
  assert.match(lines[probe.endLine - 1] ?? '', new RegExp(`<<< dsh-probe end ${probe.id}\\b`), 'endLine 应该指向 end 标记')
  // 同时核对通用检测器给出的行号一致（同一文件可能有多个探针，只看本 id）
  const markers = findMarkers(text)
    .filter((marker) => marker.id === probe.id)
    .map((marker) => marker.line)
  assert.deepEqual(markers, [probe.startLine, probe.endLine])
}

// —— 标记格式与检测 ——

test('MARKER_RE：注释包裹的标记必须命中（回归用例：旧版 \\b 会全部漏判）', () => {
  assert.equal(MARKER_RE.test('// >>> dsh-probe begin p1'), true, '// 包裹的 begin 必须命中')
  assert.equal(MARKER_RE.test('# >>> dsh-probe begin p1'), true, '# 包裹的 begin 必须命中')
  assert.equal(MARKER_RE.test('-- <<< dsh-probe end p12'), true, '-- 包裹的 end 必须命中')
  assert.equal(MARKER_RE.test('<!-- >>> dsh-probe begin p3 dt -->'), true, '<!-- --> 包裹的 begin 必须命中')
  assert.equal(MARKER_RE.test('rem >>> dsh-probe begin p4'), true, 'rem 包裹的 begin 必须命中')
  assert.equal(MARKER_RE.test('>>> dsh-probe begin p5'), true, '裸载荷也命中')
  assert.equal(MARKER_RE.test('// >>> dsh-probe 这不是标记'), false)
  assert.equal(MARKER_RE.test('const x = 1 // 只有注释，没有载荷'), false)
})

test('findMarkers：三种注释风格都能认出 begin/end，行号是 1-based', () => {
  const text = [
    'import os', // 1
    '# >>> dsh-probe begin p1 dt', // 2
    'print(1)', // 3
    '# <<< dsh-probe end p1', // 4
    'x = 1', // 5
    '# >>> dsh-probe begin p2', // 6
    '# <<< dsh-probe end p2', // 7
  ].join('\n')
  const markers = findMarkers(text)
  assert.equal(markers.length, 4)
  assert.deepEqual(
    markers.map((m) => [m.line, m.type, m.id]),
    [
      [2, 'begin', 'p1'],
      [4, 'end', 'p1'],
      [6, 'begin', 'p2'],
      [7, 'end', 'p2'],
    ],
  )
  assert.equal(markers[0].text, '# >>> dsh-probe begin p1 dt', 'text 应该是整行原文')

  const html = ['<div>', '<!-- >>> dsh-probe begin p5 -->', '  <span></span>', '<!-- <<< dsh-probe end p5 -->', '</div>'].join('\n')
  const htmlMarkers = findMarkers(html)
  assert.deepEqual(
    htmlMarkers.map((m) => [m.line, m.type, m.id]),
    [
      [2, 'begin', 'p5'],
      [4, 'end', 'p5'],
    ],
  )
  assert.equal(hasMarkers(html), true)
  assert.equal(firstMarkerLine(html), 2)
  assert.equal(firstMarkerLine('没有标记'), 0)
})

test('beginLine/endLine：带注释符的完整一行，说明文字不影响检测', () => {
  assert.equal(beginLine('line', 'p1', 'dt'), '// >>> dsh-probe begin p1 dt  (temporary; probe_clean removes this block)')
  assert.equal(beginLine('line', 'p1'), '// >>> dsh-probe begin p1  (temporary; probe_clean removes this block)')
  assert.equal(beginLine('hash', 'p2'), '# >>> dsh-probe begin p2  (temporary; probe_clean removes this block)')
  assert.equal(beginLine('block', 'p3'), '<!-- >>> dsh-probe begin p3  (temporary; probe_clean removes this block) -->')
  assert.equal(endLine('line', 'p1'), '// <<< dsh-probe end p1')
  assert.equal(endLine('hash', 'p2'), '# <<< dsh-probe end p2')
  assert.equal(endLine('block', 'p3'), '<!-- <<< dsh-probe end p3 -->')
  assert.equal(endLine('rem', 'p4'), 'rem <<< dsh-probe end p4')
  assert.equal(commentOpen('dash'), '--')
  assert.equal(commentOpen('semi'), ';')
  assert.equal(commentOpen('pct'), '%')
  assert.equal(commentOpen('quote'), "'")
  assert.equal(commentOpen('根本没这个风格'), '//', '未知风格回落 //')

  // label 里的换行/多余空白会被压平，不破坏标记行
  const messy = beginLine('line', 'p7', '  my  label\nline2  ')
  assert.equal(/[\r\n]/.test(messy), false)
  assert.equal(findMarkers(messy)[0].id, 'p7')
  // begin 行末尾随便加说明也照旧识别
  assert.equal(findMarkers('// >>> dsh-probe begin p9 note: see slack thread').length, 1)
})

test('注释符出现在代码字符串里不会误判：只有载荷匹配才算标记', () => {
  const text = [
    'const url = "https://example.com/a?x=1" // 说明',
    'const re = /\\/\\//',
    'console.log("// >>> dsh-probe")', // 有 dsh-probe 但没有 begin/end
    "const s = '# <<< dsh-probe'", // 有箭头但没有 end + id
    'let a = 1',
  ].join('\n')
  assert.equal(hasMarkers(text), false)
  assert.equal(findMarkers(text).length, 0)
  assert.equal(firstMarkerLine(text), 0)
  assert.deepEqual(stripMarkers(text), { text, removed: [], residuals: [] }, '没标记时一个字节都不改')
})

test('styleForFile：常见扩展名映射到正确的注释风格，未知回落 line', () => {
  const expected = {
    'src/a.js': 'line',
    'a.mjs': 'line',
    'a.cjs': 'line',
    'a.ts': 'line',
    'a.tsx': 'line',
    'a.jsx': 'line',
    'a.c': 'line',
    'a.h': 'line',
    'a.cpp': 'line',
    'a.hpp': 'line',
    'a.cs': 'line',
    'a.java': 'line',
    'a.go': 'line',
    'a.rs': 'line',
    'a.kt': 'line',
    'a.swift': 'line',
    'a.scala': 'line',
    'a.dart': 'line',
    'a.php': 'line',
    'a.py': 'hash',
    'a.sh': 'hash',
    'a.bash': 'hash',
    'a.zsh': 'hash',
    'a.yaml': 'hash',
    'a.yml': 'hash',
    'a.rb': 'hash',
    'a.pl': 'hash',
    'a.toml': 'hash',
    'a.ps1': 'hash',
    'a.html': 'block',
    'a.vue': 'block',
    'a.svelte': 'block',
    'a.xml': 'block',
    'a.md': 'block',
    'a.lua': 'dash',
    'a.sql': 'dash',
    'a.hs': 'dash',
    'a.ini': 'semi',
    'a.cfg': 'semi',
    'a.bat': 'rem',
    'a.cmd': 'rem',
    Makefile: 'hash',
    Dockerfile: 'hash',
  }
  for (const [file, style] of Object.entries(expected)) {
    assert.equal(styleForFile(file), style, `${file} 应该是 ${style}`)
    assert.ok(STYLES[style], `${style} 必须是 STYLES 的键`)
  }
  assert.equal(styleForFile('a.zzz'), 'line', '未知扩展名回落 line')
  assert.equal(styleForFile('README'), 'line')
  assert.equal(styleForFile(''), 'line')
  assert.equal(beginLine(styleForFile('a.zzz'), 'p1').startsWith('//'), true, '未知扩展名用 // 也安全')
  // 未知扩展名里插 // 标记不会抛错，也能被识别、被清掉
  const text = `x\n${beginLine('line', 'p1')}\ny\n${endLine('line', 'p1')}\nz\n`
  assert.equal(stripMarkers(text).text, 'x\nz\n')
})

test('EXT_STYLE 是扩展名表的单一来源，键都指向 STYLES', () => {
  for (const [ext, style] of Object.entries(EXT_STYLE)) {
    assert.ok(STYLES[style], `EXT_STYLE.${ext} 指向了不存在的风格 ${style}`)
  }
})

// —— stripMarkers ——

test('stripMarkers：块内删干净、块外一个字节不动（LF）', () => {
  const original = 'function a() {\n  return 1\n}\n'
  const text = 'function a() {\n  return 1\n' + beginLine('line', 'p1') + '\n  console.log(1)\n' + endLine('line', 'p1') + '\n}\n'
  const result = stripMarkers(text)
  assert.equal(result.text, original)
  assert.deepEqual(result.removed, [{ id: 'p1', startLine: 3, endLine: 5, lines: 3 }])
  assert.deepEqual(result.residuals, [])
})

test('stripMarkers：CRLF 换行风格保留，块外字节不变', () => {
  const original = 'function a() {\r\n  return 1\r\n}\r\n'
  const text =
    'function a() {\r\n  return 1\r\n' + beginLine('line', 'p1') + '\r\n  console.log(1)\r\n' + endLine('line', 'p1') + '\r\n}\r\n'
  const result = stripMarkers(text)
  assert.equal(result.text, original, 'CRLF 必须还原成原样')
  assert.equal(result.text.includes('\r\n'), true)
  assert.equal(/(^|[^\r])\n/.test(result.text), false, '不能出现裸 LF')
  assert.deepEqual(result.removed, [{ id: 'p1', startLine: 3, endLine: 5, lines: 3 }])
})

test('stripMarkers：幂等（第二次没有可删的东西，文本不再变）', () => {
  const text = 'a\r\n' + beginLine('hash', 'p1') + '\r\nprint(1)\r\n' + endLine('hash', 'p1') + '\r\nb\r\n'
  const once = stripMarkers(text)
  const twice = stripMarkers(once.text)
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.removed, [])
  assert.deepEqual(twice.residuals, [])
})

test('残块1：有 begin 无 end → 不抛错，记 residual，从 begin 吞到文件末尾', () => {
  const text = `a\n${beginLine('line', 'p1')}\ncode()\nmore()\n`
  const result = stripMarkers(text)
  assert.equal(result.text, 'a\n')
  assert.deepEqual(result.removed, [{ id: 'p1', startLine: 2, endLine: 4, lines: 3 }])
  assert.deepEqual(result.residuals, [{ line: 2, id: 'p1', type: 'begin', reason: 'unclosed' }])
})

test('残块2：有 end 无 begin → 不抛错，记 residual，只删孤立标记行', () => {
  const text = `a\n${endLine('line', 'p9')}\nb\n`
  const result = stripMarkers(text)
  assert.equal(result.text, 'a\nb\n')
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.residuals, [{ line: 2, id: 'p9', type: 'end', reason: 'stray-end' }])
})

test('残块3：begin/end 的 id 不匹配 → 不抛错，记两条 residual，块内容照删', () => {
  const text = `a\n${beginLine('line', 'p1')}\ncode()\n${endLine('line', 'p2')}\nb\n`
  const result = stripMarkers(text)
  assert.equal(result.text, 'a\nb\n')
  assert.deepEqual(result.removed, [{ id: 'p1', startLine: 2, endLine: 4, lines: 3 }])
  assert.deepEqual(
    result.residuals.map((r) => [r.line, r.id, r.type, r.reason]),
    [
      [2, 'p1', 'begin', 'id-mismatch'],
      [4, 'p2', 'end', 'id-mismatch'],
    ],
  )
})

test('未闭合的 begin 不会吞掉后面另一个完整块', () => {
  const text = [
    'a', // 1
    beginLine('line', 'p1'), // 2
    'probe1()', // 3
    beginLine('line', 'p2'), // 4
    'probe2()', // 5
    endLine('line', 'p2'), // 6
    'b', // 7
    '', // 8（末尾换行）
  ].join('\n')
  const result = stripMarkers(text)
  assert.equal(result.text, 'a\nb\n')
  assert.deepEqual(result.removed, [
    { id: 'p1', startLine: 2, endLine: 3, lines: 2 },
    { id: 'p2', startLine: 4, endLine: 6, lines: 3 },
  ])
  assert.deepEqual(result.residuals, [{ line: 2, id: 'p1', type: 'begin', reason: 'unclosed' }])
})

test('stripMarkers：多个块、block 注释、同一文件内混排', () => {
  const text = [
    '<div>', // 1
    beginLine('block', 'p1'), // 2
    '  <span>%s</span>', // 3
    endLine('block', 'p1'), // 4
    '<p>正文</p>', // 5
    beginLine('block', 'p2'), // 6
    endLine('block', 'p2'), // 7
    '</div>', // 8
  ].join('\n')
  const result = stripMarkers(text)
  assert.equal(result.text, '<div>\n<p>正文</p>\n</div>')
  assert.deepEqual(
    result.removed.map((r) => [r.id, r.startLine, r.endLine]),
    [
      ['p1', 2, 4],
      ['p2', 6, 7],
    ],
  )
})

// —— insertProbe：定位 ——

test('insertProbe：anchor 唯一匹配 → 插在锚点行之后，登记 probe 并拍基线', async (t) => {
  const root = makeProject(t)
  const original = 'function tick() {\n  return 1\n}\n'
  writeProjectFile(root, 'src/app.js', original)
  const session = makeSession(root)
  const result = await insertProbe({
    cwd: root,
    session,
    file: 'src/app.js',
    code: 'console.log("[probe] tick")',
    anchor: 'function tick',
  })

  assert.equal(result.file, 'src/app.js')
  assert.equal(result.probe.id, 'p1')
  assert.equal(result.probe.file, 'src/app.js')
  assert.equal(result.probe.style, 'line')
  assert.equal(result.probe.anchor, 'function tick')
  assert.equal(result.probe.indent, '', '锚点行没有前导空白，缩进应为空')
  assert.match(result.summary, /已插入探针 p1/)

  const text = readProjectFile(root, 'src/app.js')
  assertProbeLines(text, result.probe)
  assert.equal(text.startsWith('function tick() {\n'), true, '锚点行要在标记之前')
  assert.equal(text.includes('console.log("[probe] tick")'), true)
  assert.equal(stripMarkers(text).text, original, '清掉标记应还原原文')

  assert.equal(session.probes.length, 1)
  assert.equal(session.probes[0], result.probe, 'probe 就是写进 session.probes 的那条对象')
  assert.equal(loadBaseline(root, 'src/app.js'), original, '基线是插入之前的原文')
})

test('insertProbe：anchor 重复 → 报错并列出候选行号与内容，文件不动', async (t) => {
  const root = makeProject(t)
  const original = 'a()\nfunction tick(a) {\n}\nfunction tick(b) {\n}\n'
  writeProjectFile(root, 'src/app.js', original)
  const session = makeSession(root)
  await assert.rejects(
    insertProbe({ cwd: root, session, file: 'src/app.js', code: 'x()', anchor: 'function tick(' }),
    (error) => {
      assert.match(error.message, /匹配到 2 行/, '要说清匹配到几处')
      assert.match(error.message, /2: function tick\(a\)/, '要列出第 2 行与内容')
      assert.match(error.message, /4: function tick\(b\)/, '要列出第 4 行与内容')
      return true
    },
  )
  assert.equal(readProjectFile(root, 'src/app.js'), original, '校验失败一个字节都不写')
  assert.equal(session.probes.length, 0)
  assert.equal(loadBaseline(root, 'src/app.js'), null, '失败时不该拍基线')
})

test('insertProbe：anchor 不存在 → 报错', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'src/app.js', 'const a = 1\n')
  const session = makeSession(root)
  await assert.rejects(
    insertProbe({ cwd: root, session, file: 'src/app.js', code: 'x()', anchor: 'function nope(' }),
    /没找到 anchor/,
  )
  assert.equal(readProjectFile(root, 'src/app.js'), 'const a = 1\n')
})

test('insertProbe：显式 line + position after/before', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'a.js', 'one\ntwo\nthree\n')
  const session = makeSession(root)

  const before = await insertProbe({
    cwd: root,
    session,
    file: 'a.js',
    code: 'beforeCode()',
    line: 2,
    position: 'before',
    indent: 'none',
  })
  assert.equal(before.probe.startLine, 2, 'before：标记落在第 2 行')
  let text = readProjectFile(root, 'a.js')
  assertProbeLines(text, before.probe)
  assert.ok(text.indexOf('beforeCode()') < text.indexOf('two'), 'before 要插在目标行之前')

  const after = await insertProbe({
    cwd: root,
    session,
    file: 'a.js',
    code: 'afterCode()',
    line: 1,
    indent: 'none',
  })
  assert.equal(after.probe.startLine, 2, 'after：插在第 1 行之后')
  text = readProjectFile(root, 'a.js')
  assertProbeLines(text, after.probe)
  assert.ok(text.indexOf('one\n') < text.indexOf('afterCode()'))
  assert.ok(text.indexOf('afterCode()') < text.indexOf('two'), 'after 要插在目标行之后、下一行之前')
})

test('insertProbe：都不给 line/anchor → 报错说明两种用法', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'a.js', 'x\n')
  const session = makeSession(root)
  await assert.rejects(
    insertProbe({ cwd: root, session, file: 'a.js', code: 'y()' }),
    (error) => {
      assert.match(error.message, /line/)
      assert.match(error.message, /anchor/)
      return true
    },
  )
})

test('insertProbe：line 越界 / position 非法 / code 非法 → 报错且不写文件', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'a.js', 'x\n')
  const session = makeSession(root)
  await assert.rejects(insertProbe({ cwd: root, session, file: 'a.js', code: 'y()', line: 99 }), /超出文件范围/)
  await assert.rejects(insertProbe({ cwd: root, session, file: 'a.js', code: 'y()', line: 1, position: 'middle' }), /position/)
  await assert.rejects(insertProbe({ cwd: root, session, file: 'a.js', code: '   ', line: 1 }), /code 不能为空/)
  await assert.rejects(insertProbe({ cwd: root, session, file: 'a.js', code: '// >>> dsh-probe begin p1', line: 1 }), /dsh-probe/)
  assert.equal(readProjectFile(root, 'a.js'), 'x\n')
  assert.equal(session.probes.length, 0)
})

// —— insertProbe：缩进 ——

test('insertProbe：indent anchor 取锚点行的前导空白，空行保持空', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'a.js', 'function f() {\n\t\treturn 1\n}\n')
  const session = makeSession(root)
  const { probe } = await insertProbe({
    cwd: root,
    session,
    file: 'a.js',
    code: 'const dt = 1\n\nconsole.log(dt)',
    anchor: 'return 1',
  })
  assert.equal(probe.indent, '\t\t')
  assert.equal(probe.code, 'const dt = 1\n\nconsole.log(dt)', 'probe.code 保持未缩进的原文')
  const text = readProjectFile(root, 'a.js')
  assert.equal(text.includes(`${beginLine('line', 'p1')}\n\t\tconst dt = 1\n\n\t\tconsole.log(dt)\n${endLine('line', 'p1')}`), true, '空行不能被加上缩进')
  assertProbeLines(text, probe)
})

test('insertProbe：indent none / 自定义字符串', async (t) => {
  const root = makeProject(t)
  writeProjectFile(root, 'a.js', '\tif (x) {\n\t\tgo()\n\t}\n')
  const session = makeSession(root)

  const none = await insertProbe({
    cwd: root,
    session,
    file: 'a.js',
    code: 'a()\nb()',
    anchor: 'go()',
    indent: 'none',
  })
  assert.equal(none.probe.indent, '')
  let text = readProjectFile(root, 'a.js')
  assert.equal(text.includes(`${beginLine('line', 'p1')}\na()\nb()\n${endLine('line', 'p1')}`), true)

  const custom = await insertProbe({
    cwd: root,
    session,
    file: 'a.js',
    code: 'c()',
    anchor: 'go()',
    indent: '  ',
  })
  assert.equal(custom.probe.indent, '  ')
  text = readProjectFile(root, 'a.js')
  assert.equal(text.includes(`${beginLine('line', 'p2')}\n  c()\n${endLine('line', 'p2')}`), true)
})

// —— insertProbe：新建 / 路径 / 重复 ——

test('insertProbe：create 新建文件（一行注释头 + 空行）', async (t) => {
  const root = makeProject(t)
  const session = makeSession(root)
  const result = await insertProbe({
    cwd: root,
    session,
    file: 'src/new-probe.mjs',
    code: 'console.log(1)',
    line: 2,
    create: true,
    indent: 'none',
  })
  const text = readProjectFile(root, 'src/new-probe.mjs')
  const lines = realLines(text)
  assert.equal(lines[0].startsWith('//'), true, '第一行是注释头')
  assert.match(lines[0], /dsh-probe/)
  assert.equal(lines[1], '', '第二行是空行')
  assertProbeLines(text, result.probe)
  assert.equal(result.probe.style, 'line')
  assert.match(result.summary, /已新建/)
  assert.equal(
    loadBaseline(root, 'src/new-probe.mjs'),
    `${lines[0]}\n\n`,
    '新建文件的基线是刚写的注释头骨架（clean 剥掉块后正好逐字节相等）',
  )
  assert.equal(stripMarkers(text).text, `${lines[0]}\n\n`, '清掉后只剩注释头 + 空行')
})

test('insertProbe：create 且没给 line/anchor → 追加到文件末尾（不报错）', async (t) => {
  const root = makeProject(t)
  const session = makeSession(root)
  const result = await insertProbe({
    cwd: root,
    session,
    file: 'src/append-probe.mjs',
    code: 'console.log("append")',
    create: true,
  })
  const text = readProjectFile(root, 'src/append-probe.mjs')
  const lines = realLines(text)
  assert.equal(lines[0].startsWith('//'), true)
  const beginAt = lines.findIndex((line) => line.includes('>>> dsh-probe begin p1'))
  assert.equal(beginAt, lines.length - 3, '标记块要在文件末尾（begin、code、end 三行收尾）')
  assert.deepEqual(
    lines.slice(beginAt),
    [beginLine('line', 'p1'), result.probe.indent + 'console.log("append")', endLine('line', 'p1')],
  )
  assertProbeLines(text, result.probe)
})

test('insertProbe：文件不存在且没给 create → 报错', async (t) => {
  const root = makeProject(t)
  const session = makeSession(root)
  await assert.rejects(
    insertProbe({ cwd: root, session, file: 'src/nope.js', code: 'x()', line: 1 }),
    /文件不存在/,
  )
  assert.equal(fs.existsSync(path.join(root, 'src/nope.js')), false)
})

test('insertProbe：路径逃逸（../ 与外部绝对路径）被拒，不写任何文件', async (t) => {
  const root = makeProject(t)
  const session = makeSession(root)
  writeProjectFile(root, 'a.js', 'x\n')
  await assert.rejects(insertProbe({ cwd: root, session, file: '../evil.js', code: 'x()', line: 1 }), /项目内/)
  await assert.rejects(
    insertProbe({ cwd: root, session, file: path.join(os.tmpdir(), 'dsh-probe-t1-evil.js'), code: 'x()', line: 1 }),
    /项目内/,
  )
  assert.equal(fs.existsSync(path.join(root, '..', 'evil.js')), false)
})

test('insertProbe：文件里已有同 id 的残留标记 → 报错（防重复插入）', async (t) => {
  const root = makeProject(t)
  const original = `x\n${beginLine('line', 'p1')}\noldProbe()\n${endLine('line', 'p1')}\ny\n`
  writeProjectFile(root, 'a.js', original)
  const session = makeSession(root) // 新会话，nextProbeId 又是 p1
  await assert.rejects(insertProbe({ cwd: root, session, file: 'a.js', code: 'newProbe()', line: 2 }), /已经有 p1/)
  assert.equal(readProjectFile(root, 'a.js'), original)
  assert.equal(session.probes.length, 0)
})

// —— insertProbe：换行风格 / 连续插入 ——

test('insertProbe：CRLF 文件写回仍是 CRLF，清掉标记能逐字节还原', async (t) => {
  const root = makeProject(t)
  const original = 'function a() {\r\n  return 1\r\n}\r\n'
  writeProjectFile(root, 'win.js', original)
  const session = makeSession(root)
  const { probe } = await insertProbe({
    cwd: root,
    session,
    file: 'win.js',
    code: 'console.log(1)',
    anchor: 'return 1',
  })
  const text = readProjectFile(root, 'win.js')
  assert.equal(text.includes('\r\n'), true)
  assert.equal(/(^|[^\r])\n/.test(text), false, '不能混进裸 LF')
  assertProbeLines(text, probe)
  assert.equal(stripMarkers(text).text, original, 'CRLF 原文要逐字节还原')
})

test('insertProbe：同一会话连续插入 → id 递增 p1/p2，行号对得上', async (t) => {
  const root = makeProject(t)
  const original = 'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n'
  writeProjectFile(root, 'a.js', original)
  const session = makeSession(root)

  const first = await insertProbe({ cwd: root, session, file: 'a.js', code: 'one()', anchor: 'function a' })
  const second = await insertProbe({ cwd: root, session, file: 'a.js', code: 'two()', anchor: 'function b' })
  assert.equal(first.probe.id, 'p1')
  assert.equal(second.probe.id, 'p2')
  assert.deepEqual(session.probes.map((p) => p.id), ['p1', 'p2'])

  const text = readProjectFile(root, 'a.js')
  assertProbeLines(text, first.probe)
  // p2 的 begin 在文件里有两处（p1/p2），assertProbeLines 按顺序核对会失败，这里单独查
  const lines = realLines(text)
  assert.match(lines[second.probe.startLine - 1], />>> dsh-probe begin p2\b/)
  assert.match(lines[second.probe.endLine - 1], /<<< dsh-probe end p2\b/)
  assert.equal(stripMarkers(text).text, original, '两块都清掉后回到原文')
  assert.equal(loadBaseline(root, 'a.js'), original, '基线仍然是最早那版原文')
})

// —— inspectFile ——

test('inspectFile：给出行数、标记与 id 列表；文件不存在报错', async (t) => {
  const root = makeProject(t)
  const text = `a\n${beginLine('line', 'p1')}\nx()\n${endLine('line', 'p1')}\nb\n${beginLine('line', 'p2')}\n${endLine('line', 'p2')}\n`
  writeProjectFile(root, 'a.js', text)
  const info = await inspectFile({ cwd: root, file: 'a.js' })
  assert.equal(info.lines, 7)
  assert.equal(info.markers.length, 4)
  assert.deepEqual(info.probeIds, ['p1', 'p2'])
  await assert.rejects(inspectFile({ cwd: root, file: 'nope.js' }), /文件不存在/)
})
