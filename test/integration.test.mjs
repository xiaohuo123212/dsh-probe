// 端到端集成测试：假 ctx 拉起插件，跑完整探针循环。
// 不依赖 Harness 运行时，也不需要 git。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const SOURCE = [
  'export function tick(state) {',
  '  state.hp -= 1',
  '  return state',
  '}',
  '',
  'export function other() {',
  '  return 42',
  '}',
  '',
].join('\n')

function makeCtx() {
  const registry = new Map()
  const ctx = {
    tools: { register: (definition) => registry.set(definition.name, definition) },
    get: () => undefined,
    inject: () => {},
    logger: { warn() {}, debug() {}, info() {} },
  }
  apply(ctx, {})
  return { registry, call: (name, args) => registry.get(name).execute(args, {}) }
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-it-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), SOURCE, 'utf8')
  return dir
}

test('完整循环：begin → insert → script → run → report → guard → clean → guard', async () => {
  const cwd = makeProject()
  const { registry, call } = makeCtx()
  try {
    assert.equal(registry.size, 9, `应注册 9 个工具，实际 ${[...registry.keys()].join(',')}`)

    const begin = await call('probe_begin', { cwd, goal: '为什么 tick 之后 hp 变负', label: 'hp' })
    assert.match(begin.summary, /探针会话已开/)
    assert.ok(fs.existsSync(path.join(cwd, '.probe', 'session.json')))

    const emptyStatus = await call('probe_status', { cwd })
    assert.match(emptyStatus.summary, /探针 0 个/)

    const inserted = await call('probe_insert', {
      cwd,
      file: 'src/a.js',
      anchor: 'export function tick(state) {',
      code: 'console.log("[probe]", "hp", state.hp)',
      label: 'hp',
    })
    assert.match(inserted.summary, /已插入 p1/)
    const afterInsert = fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8')
    assert.match(afterInsert, new RegExp('>>> dsh-probe ' + 'begin p1'))
    assert.match(afterInsert, new RegExp('<<< dsh-probe ' + 'end p1'))
    assert.match(afterInsert, /console\.log\("\[probe\]", "hp", state\.hp\)/)

    const status = await call('probe_status', { cwd })
    assert.match(status.summary, /探针 1 个/)
    assert.match(status.summary, /src\/a\.js：p1/)

    const script = await call('probe_script', { cwd, action: 'new', name: 'repro', runtime: 'node' })
    assert.match(script.summary, /已创建探针脚本/)
    assert.ok(fs.existsSync(path.join(cwd, '.probe', 'scripts', 'repro.mjs')))

    const ranScript = await call('probe_run', { cwd, script: 'repro', args: ['--n', '3'] })
    assert.match(ranScript.summary, /退出码 0/)
    assert.ok(ranScript.result.run.probeLines.length >= 3, '模板应输出多行 [probe]')

    const ran = await call('probe_run', {
      cwd,
      command: [process.execPath, '-e', 'console.log("[probe] from-run"); console.log("noise")'],
      label: 'hello',
    })
    assert.match(ran.summary, /退出码 0/)
    assert.match(ran.summary, /from-run/)
    assert.deepEqual(ran.result.run.probeLines, ['[probe] from-run'], '只有 [probe] 行进 probeLines')
    assert.match(ran.result.stdout, /noise/, '普通输出仍留在 stdout（只是不进摘要）')
    assert.ok(fs.existsSync(path.join(cwd, ran.result.run.recordFile)), '运行记录应落盘')

    const failedRun = await call('probe_run', { cwd, command: [process.execPath, '-e', 'process.exit(3)'] })
    assert.match(failedRun.summary, /退出码 3/, '非 0 退出码要被当结果交回，而不是抛错')

    const appended = await call('probe_report', {
      cwd,
      action: 'append',
      question: 'hp 什么时候变负',
      method: '在 tick 入口插探针',
      findings: '第 3 帧后 hp=-1',
      verdict: 'explained',
    })
    assert.match(appended.summary, /已记账 Q-1/)
    assert.ok(fs.existsSync(path.join(cwd, 'PROBE.md')))
    assert.match(fs.readFileSync(path.join(cwd, 'PROBE.md'), 'utf8'), /Q-1/)

    const dirty = await call('probe_guard', { cwd })
    assert.match(dirty.summary, /守卫拦下/)
    assert.ok(dirty.result.offenders.some((o) => o.file === 'src/a.js'))

    const cleaned = await call('probe_clean', { cwd })
    assert.match(cleaned.summary, /探针拆除报告/)
    assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), SOURCE, '必须逐字节还原原始文件')
    assert.ok(!fs.existsSync(path.join(cwd, '.probe', 'scripts', 'repro.mjs')), '临时脚本应被删除')

    const clean = await call('probe_guard', { cwd })
    assert.match(clean.summary, /守卫通过/)

    const list = await call('probe_report', { cwd, action: 'list' })
    assert.match(list.summary, /Q-1/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('dry run 不动文件；再次 begin 收编会话而不是重开', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  try {
    const first = await call('probe_begin', { cwd, goal: 'dry run' })
    await call('probe_insert', { cwd, file: 'src/a.js', line: 2, code: 'console.log("[probe]", "n")' })

    const again = await call('probe_begin', { cwd, goal: '再来一次' })
    assert.match(again.summary, /已把目标写进会话/, '再次 begin 只更新目标，不重开')
    assert.equal(again.result.id, first.result.id)

    const dry = await call('probe_clean', { cwd, dryRun: true })
    assert.match(dry.summary, /\[dry run\]/)
    assert.match(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), /dsh-probe begin/, 'dry run 不该动文件')

    await call('probe_clean', { cwd })
    assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), SOURCE)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('探针之外的手工改动要保留，并在报告里点名', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  const filePath = path.join(cwd, 'src', 'a.js')
  try {
    await call('probe_begin', { cwd, goal: '改动共存' })
    await call('probe_insert', { cwd, file: 'src/a.js', anchor: 'state.hp -= 1', code: 'console.log("[probe]", "hp")' })

    const edited = fs.readFileSync(filePath, 'utf8').replace('state.hp -= 1', 'state.hp -= 2')
    fs.writeFileSync(filePath, edited, 'utf8')

    const cleaned = await call('probe_clean', { cwd })
    assert.match(cleaned.summary, /探针之外还有改动/)
    const final = fs.readFileSync(filePath, 'utf8')
    assert.ok(!final.includes('dsh-probe'), '标记必须被拆掉')
    assert.ok(final.includes('state.hp -= 2'), '手工改动必须保留')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('create=true 新建的文件，clean 后整份删掉', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  const createdFile = path.join(cwd, 'src', 'probe-created.js')
  try {
    await call('probe_begin', { cwd, goal: '新建文件里的探针' })
    await call('probe_insert', {
      cwd,
      file: 'src/probe-created.js',
      code: 'console.log("[probe]", "created")',
      create: true,
    })
    assert.ok(fs.existsSync(createdFile), 'create=true 应该建出文件')

    const cleaned = await call('probe_clean', { cwd })
    assert.match(cleaned.summary, /整份文件由探针新建/)
    assert.ok(!fs.existsSync(createdFile), '新建的文件拆完应该被删掉，而不是留空壳')
    assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), SOURCE, '别的文件不受影响')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('惰性初始化：首次 probe_insert 自动开店，probe_begin 收编同一会话', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  const sessionFile = path.join(cwd, '.probe', 'session.json')
  try {
    const inserted = await call('probe_insert', { cwd, file: 'src/a.js', line: 2, code: 'console.log("[probe]", "x")' })
    assert.match(inserted.summary, /已自动初始化探针会话/)
    assert.ok(fs.existsSync(sessionFile), '首次使用就该建好 .probe/session.json')
    const first = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert.equal(first.autoStarted, true)
    assert.equal(first.goal, null)

    const status = await call('probe_status', { cwd })
    assert.match(status.summary, /探针 1 个/)

    const adopted = await call('probe_begin', { cwd, goal: '收编这个会话', label: 'adopt' })
    assert.match(adopted.summary, /已把目标写进会话/)
    assert.match(adopted.summary, /注意：这个会话已经动了东西/, '已有探针时要提醒')
    const second = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert.equal(second.id, first.id, 'probe_begin 收编同一个会话，不重开')
    assert.equal(second.goal, '收编这个会话')
    assert.equal(second.autoStarted, false)

    const fresh = await call('probe_begin', { cwd, goal: '换一轮', reset: true })
    assert.match(fresh.summary, /探针会话已开/)
    const third = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert.notEqual(third.id, first.id, 'reset=true 才开新会话')
    assert.equal(third.goal, '换一轮')

    const cleaned = await call('probe_clean', { cwd, scanAll: true })
    assert.match(cleaned.summary, /scanAll 额外清理/, 'reset 丢弃的旧探针要靠 scanAll 兜底')
    assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), SOURCE)

    const again = await call('probe_insert', { cwd, file: 'src/a.js', line: 1, code: 'console.log("[probe]", "y")' })
    assert.match(again.summary, /已自动初始化探针会话/, 'clean 之后再使用会开一轮新会话')
    await call('probe_clean', { cwd })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('probe_report 在没有 goal 的会话上顺带补 goal', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  try {
    await call('probe_insert', { cwd, file: 'src/a.js', line: 2, code: 'console.log("[probe]", "x")' })
    const reported = await call('probe_report', {
      cwd,
      question: '为什么 hp 变负',
      findings: '第 3 帧',
      verdict: 'explained',
    })
    assert.match(reported.summary, /已顺带把这个问题写成当前会话的 goal/)
    const session = JSON.parse(fs.readFileSync(path.join(cwd, '.probe', 'session.json'), 'utf8'))
    assert.equal(session.goal, '为什么 hp 变负')
    await call('probe_clean', { cwd })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('probe_script 的只读 list/show 不会为了看一眼而建 .probe/', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  try {
    const listed = await call('probe_script', { cwd, action: 'list' })
    assert.match(listed.summary, /还没有临时探针脚本/)
    assert.ok(!fs.existsSync(path.join(cwd, '.probe')), '只读操作不该创建状态目录')
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('probe_guide 每个 section 都有内容', async () => {
  const cwd = makeProject()
  const { call } = makeCtx()
  try {
    for (const section of ['workflow', 'markers', 'scripts', 'run', 'clean', 'guard', 'pitfalls', 'languages', 'all']) {
      const out = await call('probe_guide', { section })
      assert.ok(out.summary.length > 80, `${section} 太短`)
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
