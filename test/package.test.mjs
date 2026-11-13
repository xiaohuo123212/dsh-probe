// 包完整性自检：BOM、乱码、files 清单、工具面形状。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.probe') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const SHIPPED = walk(ROOT).filter((file) => /\.(mjs|js|json|md|ps1|svg|yml)$/.test(file))

test('所有文本文件是 UTF-8 无 BOM，且没有替换字符（乱码的最后一层证据）', () => {
  const bad = []
  for (const file of SHIPPED) {
    const buf = fs.readFileSync(file)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${path.relative(ROOT, file)}: BOM`)
    const text = buf.toString('utf8')
    if (text.includes('\ufffd')) bad.push(`${path.relative(ROOT, file)}: U+FFFD`)
  }
  assert.deepEqual(bad, [], `以下文件编码有问题：\n${bad.join('\n')}`)
})

test('package.json 的 files 清单里每一项都真实存在', () => {
  const missing = []
  for (const pattern of pkg.files) {
    if (pattern.includes('*')) {
      const dir = path.join(ROOT, path.dirname(pattern))
      if (!fs.existsSync(dir)) missing.push(pattern)
      continue
    }
    if (!fs.existsSync(path.join(ROOT, pattern))) missing.push(pattern)
  }
  assert.deepEqual(missing, [], `files 清单指向了不存在的路径：${missing.join(', ')}`)
})

test('bundle 契约：name / inject / apply / cordis patch 都在', async () => {
  const mod = await import('../index.js')
  assert.equal(mod.name, 'probe')
  assert.deepEqual(mod.inject, ['tools'])
  assert.equal(typeof mod.apply, 'function')
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-probe/)
  assert.match(patch, /id: probe/)
})

test('9 个工具：名字唯一、都有描述与参数 schema', async () => {
  const { apply } = await import('../index.js')
  const tools = new Map()
  apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, get: () => undefined, inject: () => {}, logger: {} }, {})
  const expected = ['probe_begin', 'probe_status', 'probe_insert', 'probe_script', 'probe_run', 'probe_clean', 'probe_guard', 'probe_report', 'probe_guide']
  assert.deepEqual([...tools.keys()].sort(), [...expected].sort())
  for (const [name, definition] of tools) {
    assert.ok(definition.description.length > 80, `${name} 描述太短`)
    assert.equal(definition.parameters.type, 'object', `${name} 参数不是 object`)
    assert.equal(typeof definition.execute, 'function', `${name} 没有 execute`)
    assert.ok(definition.timeoutMs > 0, `${name} 没有 timeoutMs`)
  }
})

test('运行时 skill 能注册：从 PLUGIN_DIR 读出 probe.md 并交给 skills 服务', async () => {
  const { apply } = await import('../index.js')
  let registered = null
  const ctx = {
    tools: { register() {} },
    get: () => undefined,
    logger: {},
    inject(deps, callback) {
      assert.deepEqual(deps, ['skills'], '只应注入 skills 服务')
      callback({ skills: { register: (entry) => { registered = entry } } })
    },
  }
  apply(ctx, {})
  assert.ok(registered, 'skill 没有注册')
  assert.equal(registered.name, 'probe')
  assert.equal(registered.source, 'dsh-probe')
  assert.ok(registered.content.includes('probe_status'), 'skill 正文来自 skill/probe.md')
  assert.deepEqual(registered.invocation, { modelInvocable: true, userInvocable: true })
})

test('probe_guide 每个 section 都是非空字符串（防模板字面量被反引号截断）', async () => {
  const { guide, SECTIONS_NAMES } = await import('../lib/guide.js')
  assert.equal(SECTIONS_NAMES.length, 8)
  for (const name of SECTIONS_NAMES) {
    const value = guide(name)
    assert.equal(typeof value, 'string', `${name} 不是字符串（可能是模板里的反引号把它截断了）`)
    assert.ok(value.length > 80, `${name} 太短：${value.length} 字符`)
    assert.ok(!value.includes('NaN'), `${name} 里出现了 NaN，说明模板表达式被截断`)
  }
})

test('skill/probe.md 提到了全部 9 个工具', () => {  const skill = fs.readFileSync(path.join(ROOT, 'skill', 'probe.md'), 'utf8')
  for (const name of ['probe_begin', 'probe_status', 'probe_insert', 'probe_script', 'probe_run', 'probe_clean', 'probe_guard', 'probe_report', 'probe_guide']) {
    assert.ok(skill.includes(name), `skill 里没提到 ${name}`)
  }
  assert.ok(skill.split(/\r?\n/).length <= 80, 'skill 超过 80 行')
})
