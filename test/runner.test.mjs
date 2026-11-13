// dsh-probe — lib/runner.js 与 lib/scripts.js 的单元测试。
// 每个用例都在 os.tmpdir() 下建独立临时项目目录，结束就删干净；不碰用户工作区。
// 跑法：node --test test/runner.test.mjs（受限沙箱里用 node --test --test-isolation=none）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ABORTED_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  extractProbeLines,
  runCommand,
  runScript,
  runtimeCommand,
  stampNow,
  writeRunRecord,
} from '../lib/runner.js'
import { createScript, listScripts, removeScript, showScript } from '../lib/scripts.js'
import { resolvePaths } from '../lib/project.js'

const NODE = process.execPath

/** 临时项目目录 + 清理。 */
function makeProject(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-runner-'))
  t.after(() => {
    try { fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  })
  return { cwd, paths: resolvePaths(cwd) }
}

/** 最小可用 session（结构对齐 CONTRACT.md 的 session.json v1）。 */
function makeSession(overrides = {}) {
  return {
    version: 1,
    id: 'pr-test-0001',
    label: 'test',
    goal: '',
    startedAt: new Date().toISOString(),
    cwd: '',
    baseline: {},
    probes: [],
    scripts: [],
    runs: [],
    ...overrides,
  }
}

/** [process.execPath, '-e', code]：直接 spawn 的最短写法。 */
function nodeEval(code, ...rest) {
  return [NODE, '-e', code, ...rest]
}

// ---------------------------------------------------------------- extractProbeLines

test('extractProbeLines 只认 [probe] 与 PROBE| 前缀，允许前导空白并去掉首尾空白', () => {
  const text = [
    'plain line',
    '  [probe] a',
    '[PROBE] b',
    'PROBE| c',
    'probe|d',
    '\t[Probe] e',
    '[probeX] 不算',
    'x [probe] 不算',
    'PROBE中间出现不算',
  ].join('\n')
  assert.deepEqual(extractProbeLines(text), ['[probe] a', '[PROBE] b', 'PROBE| c', 'probe|d', '[Probe] e'])
})

test('extractProbeLines 处理空输入与 CRLF 换行', () => {
  assert.deepEqual(extractProbeLines(''), [])
  assert.deepEqual(extractProbeLines(undefined), [])
  assert.deepEqual(extractProbeLines('[probe] a\r\n[probe] b\r\n'), ['[probe] a', '[probe] b'])
})

// ---------------------------------------------------------------- runCommand

test('runCommand 数组命令直接 spawn（不经过 shell），能收回 stdout/stderr 与 probeLines', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({
    cwd,
    command: nodeEval('console.log("[probe] arr-ok"); console.error("warn-here")'),
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.signal, null)
  assert.match(result.stdout, /\[probe\] arr-ok/)
  assert.match(result.stderr, /warn-here/)
  assert.deepEqual(result.probeLines, ['[probe] arr-ok'])
  assert.equal(result.truncated, false)
  assert.equal(result.timedOut, false)
  assert.ok(result.durationMs >= 0, 'durationMs 应是非负数')
})

test('runCommand 数组命令的参数逐字交给子进程，不被 shell 二次解释', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({
    cwd,
    command: nodeEval('console.log("[probe] arg=" + process.argv[1])', 'a b"c&d'),
  })
  // 走 shell 的话这个参数会被拆开或吃掉 &，"a b"c&d 会变形。
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /arg=a b"c&d/)
})

test('runCommand shell 字符串命令走平台 shell 执行', async (t) => {
  const { cwd } = makeProject(t)
  const command = process.platform === 'win32' ? 'echo [probe] shell-ok' : 'printf "[probe] shell-ok\\n"'
  const result = await runCommand({ cwd, command })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.probeLines, ['[probe] shell-ok'])
})

test('runCommand 非 0 退出码不抛错，把失败信息交回', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({
    cwd,
    command: nodeEval('console.log("[probe] before-fail"); console.error("boom"); process.exit(3)'),
  })
  assert.equal(result.exitCode, 3)
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /boom/)
  assert.deepEqual(result.probeLines, ['[probe] before-fail'])
})

test('runCommand 超时会杀掉进程树、置 timedOut 与退出码 124', async (t) => {
  const { cwd } = makeProject(t)
  const started = Date.now()
  const result = await runCommand({ cwd, command: nodeEval('setTimeout(() => {}, 10000)'), timeoutSec: 1 })
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE)
  assert.ok(elapsed < 8000, `超时后应尽快返回（子进程别跑满 10 秒），实际 ${elapsed}ms`)
  assert.ok(result.durationMs >= 800, `至少应该等到 timeoutSec=1，实际 ${result.durationMs}ms`)
})

test('runCommand 输出超过 maxOutputBytes 会截断，但 probeLines 仍从完整输出里抽', async (t) => {
  const { cwd } = makeProject(t)
  const code = [
    "process.stdout.write('x'.repeat(200000))",
    "process.stdout.write('\\n')",
    "console.log('[probe] tail-marker')",
  ].join(';')
  const result = await runCommand({ cwd, command: nodeEval(code), maxOutputBytes: 4096 })
  assert.equal(result.truncated, true)
  assert.ok(
    Buffer.byteLength(result.stdout, 'utf8') <= 4096,
    `stdout 应被截到 4096 字节以内，实际 ${Buffer.byteLength(result.stdout, 'utf8')}`,
  )
  // 关键：截断只影响落盘文本，不能把后面的 [probe] 行截没。
  assert.deepEqual(result.probeLines, ['[probe] tail-marker'])
})

test('runCommand collect=false 时不抽 probeLines，但 stdout 照旧收', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({
    cwd,
    command: nodeEval('console.log("[probe] hidden")'),
    collect: false,
  })
  assert.deepEqual(result.probeLines, [])
  assert.match(result.stdout, /\[probe\] hidden/)
})

test('runCommand 能透传 env 给子进程', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({
    cwd,
    command: nodeEval('console.log("[probe] env=" + process.env.DSH_PROBE_TEST)'),
    env: { DSH_PROBE_TEST: 'yes-42' },
  })
  assert.deepEqual(result.probeLines, ['[probe] env=yes-42'])
})

test('runCommand 被 AbortSignal 中止时会杀掉子进程并标记 aborted', async (t) => {
  const { cwd } = makeProject(t)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300)
  t.after(() => clearTimeout(timer))
  const started = Date.now()
  const result = await runCommand({
    cwd,
    command: nodeEval('setTimeout(() => {}, 10000)'),
    signal: controller.signal,
  })
  const elapsed = Date.now() - started
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.ok(elapsed < 8000, `中止后应尽快返回，实际 ${elapsed}ms`)
  assert.ok(
    result.exitCode === ABORTED_EXIT_CODE || typeof result.exitCode === 'number',
    `exitCode 应是数字，实际 ${JSON.stringify(result.exitCode)}`,
  )
})

test('runCommand 命令不存在时按 127 交回，不抛错', async (t) => {
  const { cwd } = makeProject(t)
  const result = await runCommand({ cwd, command: ['dsh-probe-no-such-binary-xyz'] })
  assert.equal(result.exitCode, 127)
  assert.match(result.stderr, /dsh-probe-no-such-binary-xyz/)
})

// ---------------------------------------------------------------- runtimeCommand / runScript

test('runtimeCommand 按 runtime 组出正确的 argv', () => {
  assert.deepEqual(runtimeCommand('node', 'a.mjs', ['--foo', '1']), [NODE, 'a.mjs', '--foo', '1'])
  assert.deepEqual(runtimeCommand('python', 'a.py', ['--foo']), ['python', 'a.py', '--foo'])
  assert.deepEqual(runtimeCommand('powershell', 'a.ps1', []), [
    'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'a.ps1',
  ])
  assert.deepEqual(runtimeCommand('node', 'a.mjs'), [NODE, 'a.mjs'])
  assert.throws(() => runtimeCommand('ruby', 'a.rb', []), /不支持的脚本 runtime/)
})

test('runScript 未登记的脚本名会报错并提示用 probe_script action=new', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await assert.rejects(
    () => runScript({ cwd, session, name: 'ghost' }),
    /probe_script action=new/,
  )
})

// ---------------------------------------------------------------- writeRunRecord

test('writeRunRecord 写 .probe/runs/<ts>-<slug>.json，返回正斜杠相对路径并推进 session.runs', async (t) => {
  const { cwd, paths } = makeProject(t)
  const session = makeSession()
  const result = await runCommand({ cwd, command: nodeEval('console.log("[probe] record-ok")') })
  const rel = writeRunRecord(paths, session, { label: 'check', command: '[node] -e', ...result })

  assert.match(rel, /^\.probe\/runs\/\d{8}-\d{6}-check\.json$/)
  assert.ok(!rel.includes('\\'), '返回路径必须是正斜杠')
  const record = JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8'))
  assert.equal(record.exitCode, 0)
  assert.deepEqual(record.probeLines, ['[probe] record-ok'])
  assert.match(record.stdout, /record-ok/)

  assert.equal(session.runs.length, 1)
  assert.equal(session.runs[0].recordFile, rel)
  assert.equal(session.runs[0].label, 'check')
  assert.equal(session.runs[0].id, 'r1')
  assert.ok(session.runs[0].createdAt, 'session.runs 条目要有 createdAt')
  assert.equal(session.runs[0].stdout, undefined, 'session.runs 里不要塞整份 stdout')
})

test('writeRunRecord 落盘前用 tailText 给 stdout/stderr 截尾', async (t) => {
  const { cwd, paths } = makeProject(t)
  const session = makeSession()
  const longStdout = Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n')
  const rel = writeRunRecord(paths, session, {
    label: 'tail', command: 'echo x', exitCode: 0, durationMs: 1,
    probeLines: [], stdout: longStdout, stderr: '',
  })
  const record = JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8'))
  assert.match(record.stdout, /lines omitted/)
  assert.ok(!record.stdout.includes('line-0'), '最老的行应该被截掉')
  assert.match(record.stdout, /line-299$/, '最新一行要留着')
})

test('writeRunRecord 保证 session.runs 不超过 maxRuns，超了丢最旧的', async (t) => {
  const { paths } = makeProject(t)
  const session = makeSession()
  for (let i = 1; i <= 5; i += 1) {
    writeRunRecord(paths, session, { label: `run-${i}`, command: 'echo x', exitCode: 0, durationMs: 1, probeLines: [] }, { maxRuns: 3 })
  }
  assert.equal(session.runs.length, 3)
  assert.deepEqual(session.runs.map((run) => run.label), ['run-3', 'run-4', 'run-5'])
  assert.deepEqual(session.runs.map((run) => run.id), ['r3', 'r4', 'r5'])
  assert.ok(session.runs.every((run) => typeof run.recordFile === 'string' && run.recordFile.startsWith('.probe/runs/')))
})

test('stampNow 输出 YYYYMMDD-HHMMSS 形状的时间戳', () => {
  assert.match(stampNow(new Date(2026, 10, 13, 1, 27, 0)), /^20261113-012700$/)
})

// ---------------------------------------------------------------- scripts

test('createScript 默认 node、落 .probe/scripts/<slug>.mjs，首行带 dsh-probe 标记', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  const { script, file, created, backup } = await createScript({ cwd, session, name: 'check' })

  assert.equal(created, true)
  assert.equal(backup, null)
  assert.equal(script.runtime, 'node')
  assert.equal(file, '.probe/scripts/check.mjs')
  assert.equal(session.scripts.length, 1)
  assert.equal(session.scripts[0].file, file)

  const text = fs.readFileSync(path.join(cwd, file), 'utf8')
  const firstLine = text.split('\n')[0]
  assert.match(firstLine, /^\/\/ dsh-probe script: check（临时；probe_clean 会删除）$/)
  assert.match(text, /process\.argv\.slice\(2\)/, 'node 模板要自带参数解析')
  assert.match(text, /\[probe\]/, '模板要演示 [probe] 输出约定')
})

test('node 模板能直接用 runScript 跑通并产出 [probe] 行', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await createScript({ cwd, session, name: 'check' })
  const result = await runScript({ cwd, session, name: 'check', args: ['--foo', '1'] })

  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.ok(result.probeLines.length >= 1, `应抽到 [probe] 行，实际 ${JSON.stringify(result.probeLines)}`)
  assert.ok(result.probeLines.includes('[probe] ok'), '模板最后一行 [probe] ok 必须能被 runScript 摘到')
  assert.match(result.stdout, /script=check/)
  assert.match(result.stdout, /--foo/, '命令行的 --foo 1 要能传到脚本里')
  assert.deepEqual(result.script, { name: 'check', runtime: 'node', file: '.probe/scripts/check.mjs' })
  assert.equal(result.argv[0], NODE)
})

test('node 模板能直接 node .probe/scripts/<name>.mjs --foo 1 跑通', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  const { file } = await createScript({ cwd, session, name: 'check' })
  // 用法注释里写的就是这条命令：相对路径 + 参数，在项目根下直接跑。
  const result = await runCommand({ cwd, command: [NODE, file, '--foo', '1'] })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /\[probe\] script=check/)
  assert.match(result.stdout, /"foo":"1"/)
  assert.deepEqual(result.probeLines.slice(-1), ['[probe] ok'])
})

test('python / powershell 模板也能创建，扩展名与参数解析结构正确', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()

  const py = await createScript({ cwd, session, name: 'check-py', runtime: 'python' })
  assert.equal(py.file, '.probe/scripts/check-py.py')
  const pyText = fs.readFileSync(path.join(cwd, py.file), 'utf8')
  assert.match(pyText.split('\n')[0], /^# dsh-probe script: check-py（临时；probe_clean 会删除）$/)
  assert.match(pyText, /sys\.argv\[1:\]/)
  assert.match(pyText, /\[probe\]/)

  const ps = await createScript({ cwd, session, name: 'check-ps', runtime: 'powershell' })
  assert.equal(ps.file, '.probe/scripts/check-ps.ps1')
  const psText = fs.readFileSync(path.join(cwd, ps.file), 'utf8')
  assert.match(psText.split('\n')[0], /^# dsh-probe script: check-ps（临时；probe_clean 会删除）$/)
  assert.match(psText, /param\(\[Parameter\(ValueFromRemainingArguments=\$true\)\]\$Rest\)/)
  assert.match(psText, /\[probe\]/)

  assert.equal(session.scripts.length, 2)
})

test('createScript runtime=auto 按名字后缀猜，未知后缀默认 node', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()

  const py = await createScript({ cwd, session, name: 'guess.py', runtime: 'auto' })
  assert.equal(py.script.runtime, 'python')
  assert.equal(py.file, '.probe/scripts/guess.py')

  const ps = await createScript({ cwd, session, name: 'guess2.ps1', runtime: 'auto' })
  assert.equal(ps.script.runtime, 'powershell')
  assert.equal(ps.file, '.probe/scripts/guess2.ps1')

  const plain = await createScript({ cwd, session, name: 'guess3' })
  assert.equal(plain.script.runtime, 'node')
  assert.equal(plain.file, '.probe/scripts/guess3.mjs')

  await assert.rejects(() => createScript({ cwd, session, name: 'bad', runtime: 'ruby' }), /runtime 只能是/)
})

test('createScript 已存在又没 force 会报错；force 覆盖会先备份到 .probe/tmp/', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await createScript({ cwd, session, name: 'check', body: '// v1\nconsole.log("[probe] v1")\n' })

  await assert.rejects(
    () => createScript({ cwd, session, name: 'check', body: '// v2\n' }),
    /已存在.*force/,
  )

  const again = await createScript({ cwd, session, name: 'check', body: '// v2\n', force: true })
  assert.equal(again.created, false)
  assert.match(again.backup, /^\.probe\/tmp\/check\.mjs\.bak-\d{8}-\d{6}$/)
  assert.equal(fs.readFileSync(path.join(cwd, again.backup), 'utf8'), '// v1\nconsole.log("[probe] v1")\n')
  assert.equal(fs.readFileSync(path.join(cwd, again.file), 'utf8'), '// v2\n')
  assert.equal(session.scripts.length, 1, '同名脚本要替换登记，不要留两条')
})

test('listScripts 以 session.scripts 为准，只返回磁盘还活着的，markers 反映源标记', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await createScript({ cwd, session, name: 'alive' })
  await createScript({
    cwd, session, name: 'withmarkers',
    body: '// >>> dsh-probe begin p1\nconsole.log("[probe] x")\n// <<< dsh-probe end p1\n',
  })
  await createScript({ cwd, session, name: 'gone' })
  fs.unlinkSync(path.join(cwd, '.probe/scripts/gone.mjs'))

  const items = listScripts({ cwd, session })
  assert.deepEqual(items.map((item) => item.name), ['alive', 'withmarkers'], '磁盘上没了的脚本不列出')
  const [alive, withMarkers] = items
  assert.equal(alive.runtime, 'node')
  assert.equal(alive.file, '.probe/scripts/alive.mjs')
  assert.ok(alive.bytes > 0, 'bytes 应该是正数')
  assert.equal(alive.markers, false, '模板本身不含探针标记')
  assert.equal(withMarkers.markers, true, '含 >>> dsh-probe begin 的脚本 markers 应为 true')
  // listScripts 只读不写：session 里那条磁盘上没了的登记还在，交给 probe_clean 处理。
  assert.ok(session.scripts.some((item) => item.name === 'gone'))
})

test('showScript 返回全文；没登记和文件丢了都报错', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await createScript({ cwd, session, name: 'check' })

  const shown = showScript({ cwd, session, name: 'check' })
  assert.equal(shown.name, 'check')
  assert.equal(shown.runtime, 'node')
  assert.equal(shown.file, '.probe/scripts/check.mjs')
  assert.match(shown.text, /\[probe\]/)

  assert.throws(() => showScript({ cwd, session, name: 'nope' }), /没有登记名为 nope 的探针脚本/)

  fs.unlinkSync(path.join(cwd, '.probe/scripts/check.mjs'))
  assert.throws(() => showScript({ cwd, session, name: 'check' }), /文件不见了/)
})

test('removeScript 删磁盘文件并从 session 摘除，重复删除会报错', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await createScript({ cwd, session, name: 'check' })

  const removed = removeScript({ cwd, session, name: 'check' })
  assert.equal(removed.name, 'check')
  assert.equal(removed.deleted, true)
  assert.equal(fs.existsSync(path.join(cwd, '.probe/scripts/check.mjs')), false)
  assert.equal(session.scripts.length, 0)

  assert.throws(() => removeScript({ cwd, session, name: 'check' }), /没有登记名为 check 的探针脚本/)
})

test('createScript 拒绝带路径分隔符的名字，避免写出 .probe/scripts/', async (t) => {
  const { cwd } = makeProject(t)
  const session = makeSession()
  await assert.rejects(() => createScript({ cwd, session, name: '../evil' }), /脚本名/)
  await assert.rejects(() => createScript({ cwd, session, name: 'a/b' }), /脚本名/)
  await assert.rejects(() => createScript({ cwd, session, name: '  ' }), /脚本名不能为空/)
  assert.equal(session.scripts.length, 0)
})
