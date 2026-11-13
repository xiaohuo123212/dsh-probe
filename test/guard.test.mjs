// dsh-probe — guard / report 的行为测试。node --test test/guard.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardScan, residualScan } from '../lib/guard.js'
import { appendLedger, listLedger, ledgerSummary } from '../lib/report.js'

const temporary = []

function makeProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-probe-${name}-`))
  temporary.push(dir)
  return dir
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function writeRaw(dir, rel, buffer) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buffer)
  return abs
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8')
}

function runGit(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** git init 成功才返回 true；好了再把文件写进去。 */
function initGit(dir, t) {
  const init = runGit(dir, ['init', '-q'])
  if (!init.ok) {
    t.skip(`本机没有可用的 git，跳过：${init.out.trim().slice(0, 120)}`)
    return false
  }
  return true
}

function markerText(id = 'p1') {
  return [
    'export function tick() {',
    `  // >>> dsh-probe begin ${id}    (temporary; probe_clean removes this block)`,
    '  console.log("[probe] tick", Date.now())',
    `  // <<< dsh-probe end ${id}`,
    '}',
  ].join('\n')
}

after(() => {
  for (const dir of temporary) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论
    }
  }
})

// ---------------------------------------------------------------------------
// guardScan
// ---------------------------------------------------------------------------

test('干净目录：没有标记时 guardScan 返回 ok=true', async () => {
  const dir = makeProject('clean')
  writeFile(dir, 'src/a.js', 'export const a = 1\nexport const b = 2\n')
  // 普通提到 dsh-probe 的文档不算命中（只有带 >>> / <<< 的标记才算）
  writeFile(dir, 'README.md', '这是 dsh-probe 插件的说明，提到 dsh-probe 是正常的。\n')

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, true, `不该有残留：${JSON.stringify(result.offenders)}`)
  assert.deepEqual(result.offenders, [])
  assert.equal(result.trackedProbeDir, false)
  assert.equal(result.scannedFiles, 2)
  assert.ok(Array.isArray(result.warnings))
})

test('含标记的文件被检出，行号与 id 对得上', async () => {
  const dir = makeProject('hit')
  writeFile(dir, 'src/a.js', markerText('p1'))

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, false)
  assert.equal(result.offenders.length, 2, JSON.stringify(result.offenders))
  assert.deepEqual(
    result.offenders.map((item) => `${item.file}:${item.line}:${item.id}`),
    ['src/a.js:2:p1', 'src/a.js:4:p1'],
  )
  assert.ok(result.offenders[0].text.includes('>>>'), `命中行文本不对：${result.offenders[0].text}`)
  assert.ok(result.offenders[1].text.includes('<<<'), `命中行文本不对：${result.offenders[1].text}`)
})

test('结果按文件 + 行号升序排列', async () => {
  const dir = makeProject('sort')
  writeFile(dir, 'src/b.js', markerText('p2'))
  writeFile(dir, 'src/a.js', markerText('p1'))

  const result = await guardScan({ cwd: dir })

  const files = result.offenders.map((item) => item.file)
  assert.deepEqual(files, ['src/a.js', 'src/a.js', 'src/b.js', 'src/b.js'])
  assert.deepEqual(
    result.offenders.map((item) => item.line),
    [2, 4, 2, 4],
  )
})

test('node_modules 被跳过', async () => {
  const dir = makeProject('node-modules')
  writeFile(dir, 'node_modules/some-pkg/index.js', '// >>> dsh-probe begin p9\n')
  writeFile(dir, 'src/a.js', 'export const a = 1\n')

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, true, JSON.stringify(result.offenders))
  assert.deepEqual(result.offenders, [])
  assert.equal(result.scannedFiles, 1, '只该扫到 src/a.js')
})

test('二进制文件被跳过（含 NUL 不按文本扫）', async () => {
  const dir = makeProject('binary')
  writeRaw(
    dir,
    'assets/blob.bin',
    Buffer.concat([Buffer.from('// >>> dsh-probe begin p1\n'), Buffer.from([0, 1, 2, 3, 0])]),
  )

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, true, JSON.stringify(result.offenders))
  assert.deepEqual(result.offenders, [])
  assert.equal(result.scannedFiles, 0)
})

test('非 git 目录：降级为遍历目录扫描，不抛错', async () => {
  const dir = makeProject('no-git')
  writeFile(dir, 'deep/nested/x.js', markerText('p3'))
  writeFile(dir, 'dist/bundle.js', '// >>> dsh-probe begin p4\n')

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.offenders.map((item) => `${item.file}:${item.line}`),
    ['deep/nested/x.js:2', 'deep/nested/x.js:4'],
  )
  assert.ok(
    result.warnings.some((warning) => warning.includes('不是 git 仓库')),
    `应有降级提示：${JSON.stringify(result.warnings)}`,
  )
})

test('超大文件按 maxScanBytes 跳过', async () => {
  const dir = makeProject('too-big')
  writeFile(dir, 'big.js', `// >>> dsh-probe begin p1\n${'x'.repeat(4096)}`)
  writeFile(dir, 'small.js', 'export const a = 1\n')

  const result = await guardScan({ cwd: dir, options: { maxScanBytes: 512 } })

  assert.equal(result.ok, true, JSON.stringify(result.offenders))
  assert.deepEqual(result.offenders, [])
  assert.equal(result.scannedFiles, 1)
  assert.ok(result.warnings.some((warning) => warning.includes('maxScanBytes')), JSON.stringify(result.warnings))
})

test('.probe/ 里的会话与基线不产生误报', async () => {
  const dir = makeProject('probe-dir')
  writeFile(
    dir,
    '.probe/session.json',
    JSON.stringify(
      { version: 1, probes: [{ id: 'p1', file: 'src/a.js', code: '// >>> dsh-probe begin p1' }] },
      null,
      2,
    ),
  )
  writeFile(dir, '.probe/baseline/src__a.js', '// >>> dsh-probe begin p1\nconsole.log(1)\n')
  writeFile(dir, '.probe/runs/20261113-012700-check.json', '{"probeLines":["// >>> dsh-probe begin p1"]}\n')
  writeFile(dir, 'src/a.js', 'export const a = 1\n')

  const result = await guardScan({ cwd: dir })

  assert.equal(result.ok, true, JSON.stringify(result.offenders))
  assert.deepEqual(result.offenders, [])
  assert.equal(result.scannedFiles, 1, '只该扫到 src/a.js')
})

test('scope=staged 只看暂存区（git 仓库）', async (t) => {
  const dir = makeProject('git-staged')
  if (!initGit(dir, t)) return
  writeFile(dir, 'src/a.js', 'export const a = 1\n')
  writeFile(dir, 'src/b.js', markerText('p7'))

  const add = runGit(dir, ['add', 'src/b.js'])
  assert.equal(add.ok, true, `git add 失败：${add.out}`)

  const staged = await guardScan({ cwd: dir, scope: 'staged' })
  assert.equal(staged.ok, false)
  assert.deepEqual(
    staged.offenders.map((item) => item.file),
    ['src/b.js', 'src/b.js'],
  )

  const worktree = await guardScan({ cwd: dir, scope: 'worktree' })
  assert.ok(
    worktree.offenders.some((item) => item.file === 'src/b.js'),
    'worktree 也应看到未提交的标记',
  )
})

test('git 跟踪了 .probe/ 时给 warning 并置 trackedProbeDir', async (t) => {
  const dir = makeProject('git-tracked-probe')
  if (!initGit(dir, t)) return
  writeFile(dir, 'src/a.js', 'export const a = 1\n')
  writeFile(dir, '.probe/ledger.json', '[]\n')
  const add = runGit(dir, ['add', 'src/a.js', '-f', '.probe/ledger.json'])
  assert.equal(add.ok, true, `git add 失败：${add.out}`)

  const result = await guardScan({ cwd: dir })

  assert.equal(result.trackedProbeDir, true)
  assert.ok(
    result.warnings.some((warning) => warning.includes('.probe')),
    `应有 .probe 跟踪提示：${JSON.stringify(result.warnings)}`,
  )
})

// ---------------------------------------------------------------------------
// residualScan
// ---------------------------------------------------------------------------

test('residualScan 只报告本次会话涉及的文件', async () => {
  const dir = makeProject('residual')
  writeFile(dir, 'src/a.js', markerText('p1'))
  writeFile(dir, 'src/b.js', 'export const b = 1\n')
  writeFile(dir, 'src/other.js', markerText('p2'))

  const session = {
    version: 1,
    probes: [
      { id: 'p1', file: 'src/a.js' },
      { id: 'p2', file: 'src/b.js' },
      { id: 'p3', file: 'src/missing.js' },
    ],
  }

  const result = await residualScan({ cwd: dir, session })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.offenders.map((item) => `${item.file}:${item.line}:${item.id}`),
    ['src/a.js:2:p1', 'src/a.js:4:p1'],
  )
  assert.deepEqual(result.missingFiles, ['src/missing.js'])
  assert.ok(
    !result.offenders.some((item) => item.file === 'src/other.js'),
    '不在 session 里的文件不该被报',
  )
})

test('residualScan 全部清干净时 ok=true', async () => {
  const dir = makeProject('residual-clean')
  writeFile(dir, 'src/a.js', 'export const a = 1\n')

  const result = await residualScan({ cwd: dir, session: { probes: [{ id: 'p1', file: 'src/a.js' }] } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.offenders, [])
  assert.deepEqual(result.missingFiles, [])
})

// ---------------------------------------------------------------------------
// report：账本
// ---------------------------------------------------------------------------

test('账本追加两条：id 递增、ledger.json 是数组、PROBE.md 有两个小节', async () => {
  const dir = makeProject('ledger')

  const first = appendLedger(
    { cwd: dir },
    { question: '为什么 tick 里耗时忽高忽低', method: '插一行打点后跑 3 次', findings: '首次调用多 12ms', verdict: 'explained', notes: '冷启动' },
  )
  const second = appendLedger(
    { cwd: dir },
    { question: '缓存真的命中了吗', method: '临时打点 2 次', findings: 'second 命中', verdict: 'inconclusive' },
  )

  assert.equal(first.id, 'Q-1')
  assert.equal(second.id, 'Q-2')
  assert.equal(first.file, 'PROBE.md')
  assert.equal(first.entry.verdict, 'explained')
  assert.equal(first.entry.id, 'Q-1')
  assert.ok(first.entry.at, '应有时间戳')

  const ledger = JSON.parse(readFile(dir, '.probe/ledger.json'))
  assert.ok(Array.isArray(ledger), 'ledger.json 应是数组')
  assert.equal(ledger.length, 2)
  assert.deepEqual(
    ledger.map((item) => item.id),
    ['Q-1', 'Q-2'],
  )

  const md = readFile(dir, 'PROBE.md')
  assert.ok(md.startsWith('# 探针账本（probe ledger）'), `PROBE.md 缺标题：${md.slice(0, 40)}`)
  assert.equal((md.match(/^## Q-\d+ · /gm) ?? []).length, 2)
  assert.ok(md.includes('## Q-1 · 为什么 tick 里耗时忽高忽低'))
  assert.ok(md.includes('- 结论：explained'))
  assert.ok(md.includes('- 方法：插一行打点后跑 3 次'))
  assert.ok(md.includes('- 发现：首次调用多 12ms'))
  assert.ok(md.includes('- 备注：冷启动'))
  assert.ok(/- 时间：\d{4}-\d{2}-\d{2}T/.test(md), '缺少 ISO 时间行')

  // 无 BOM
  assert.notEqual(readFile(dir, '.probe/ledger.json').charCodeAt(0), 0xfeff)
  assert.notEqual(md.charCodeAt(0), 0xfeff)
})

test('账本拒绝空 question 与非法 verdict', async () => {
  const dir = makeProject('ledger-invalid')

  assert.throws(() => appendLedger({ cwd: dir }, { question: '   ', verdict: 'explained' }), /question/)
  assert.throws(() => appendLedger({ cwd: dir }, { question: '试试', verdict: 'maybe' }), /verdict/)
  assert.ok(!fs.existsSync(path.join(dir, '.probe/ledger.json')), '校验失败不该落盘')
})

test('listLedger 最新在前且遵守 limit', async () => {
  const dir = makeProject('ledger-list')
  for (let index = 1; index <= 22; index += 1) {
    appendLedger({ cwd: dir }, { question: `第 ${index} 问`, verdict: 'explained' })
  }

  const all = listLedger({ cwd: dir })
  assert.equal(all.total, 22)
  assert.equal(all.items.length, 20, '默认只回 20 条')
  assert.equal(all.items[0].id, 'Q-22')
  assert.equal(all.items[19].id, 'Q-3')

  const limited = listLedger({ cwd: dir }, { limit: 2 })
  assert.equal(limited.total, 22)
  assert.deepEqual(
    limited.items.map((item) => item.id),
    ['Q-22', 'Q-21'],
  )
})

test('ledgerSummary 计数正确并带最近一条', async () => {
  const dir = makeProject('ledger-summary')

  const empty = ledgerSummary({ cwd: dir })
  assert.deepEqual(empty, { total: 0, byVerdict: { explained: 0, refuted: 0, inconclusive: 0 }, last: null })

  appendLedger({ cwd: dir }, { question: 'a', verdict: 'explained' })
  appendLedger({ cwd: dir }, { question: 'b', verdict: 'refuted' })
  appendLedger({ cwd: dir }, { question: 'c', verdict: 'inconclusive' })
  const last = appendLedger({ cwd: dir }, { question: 'd' })

  const summary = ledgerSummary({ cwd: dir })
  assert.equal(summary.total, 4)
  assert.deepEqual(summary.byVerdict, { explained: 1, refuted: 1, inconclusive: 2 })
  assert.equal(summary.last.id, last.id)
  assert.equal(summary.last.id, 'Q-4')
  assert.equal(summary.last.verdict, 'inconclusive', '未给 verdict 时按 inconclusive 记')
})
