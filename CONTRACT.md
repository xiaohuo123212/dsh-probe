# dsh-probe 实现契约（单一定义源，改动必须先改这里）

## 这是什么

DSH 插件 `dsh-probe`：改代码时的**临时探针工作台**。解决三件事——探针**插得准**、**跑得动**、**删得干净**，并留下「问过什么、答了什么」的账本。

跟 `~/.dsh/plugins/dsh-perf-opt` 是同一类东西、同一种写法：
- 纯 ESM，**不 import 任何 Harness 包**（只用 node: 内置模块），因为要被 link 进 profile 目录。
- 工具用普通 JSON Schema 字面量 + 手写参数校验，不用 `defineTool`。
- 入口：`export const name`、`export const inject = ['tools']`、`export function apply(ctx, config)`；技能用 `ctx.inject(['skills'], ...)`。
- 所有工具返回 `{summary: string, result?: object}`，`summary` 是给人/模型看的中文短文本。

## 文件所有权（并行开发时不许越界）

| 文件 | 负责人 |
|---|---|
| `lib/util.js` `lib/project.js` `lib/store.js` `lib/guide.js` `index.js` `package.json` `cordis.patch.yml` `locale/*` `install/*` `test/integration.test.mjs` | Lead |
| `lib/markers.js` `lib/insert.js` `test/markers.test.mjs` | T1 |
| `lib/runner.js` `lib/scripts.js` `test/runner.test.mjs` | T2 |
| `lib/guard.js` `lib/report.js` `test/guard.test.mjs` | T3 |
| `skill/probe.md` `docs/DESIGN.md` `README.md` | T4 |

只写自己名下的文件。需要别人的函数就先按本契约里的签名调用；签名要变，先在本文件里改。

## 全局约定

- 所有文件读写 UTF-8、**不写 BOM**；JSON 用 2 空格缩进。
- 路径一律用 `node:path`，落盘用正斜杠相对路径（`relPosix`）。
- 用户可见的报错用 `throw new Error('...')`，中文、一句话、说清下一步。不要 `process.exit`。
- 不打印到 stdout（会污染工具输出）；调试用 `ctx.logger?.debug?.()`。
- Windows 优先，但代码不能假设 Windows（除 `install/` 下的 ps1）。
- 时间戳用 `nowIso()`；id 用 `makeId(prefix)`。

## 数据与目录

工作目录（= 用户项目根，`cwd`）下：

```
.probe/
  session.json          探针会话（唯一状态文件）
  baseline/<rel>        插探针**之前**的原文件副本（rel 里的 /\ 换成 __）
  scripts/<name>.<ext>  探针脚本（临时）
  runs/<ts>-<slug>.json 每次 probe_run 的记录
  tmp/
  ledger.json           探针账本（结构化）
PROBE.md                探针账本（人读）
```

### `session.json`（v1）

```js
{
  version: 1,
  id: 'pr-20261113-0127-ab12',      // makeId('pr')，带随机后缀防同秒撞号
  label: 'string',                   // probe_begin 的 label；惰性初始化时取 cwd 目录名
  goal: 'string | null',             // 这次想弄清什么；惰性初始化时为 null，probe_begin / probe_report 补
  autoStarted: true,                 // 首次使用自动创建、还没收编时是 true；probe_begin 收编后置 false
  startedAt: '2026-11-13T01:27:00.000Z',
  cwd: 'C:/Users/x/proj',
  baseline: {                        // 只记录**被插过探针的文件**
    'src/a.js': { sha256: '...', bytes: 1234, lines: 40, savedAt: '...' }
  },
  probes: [ {
    id: 'p1',                        // 会话内自增，p1 p2 ...
    file: 'src/a.js',                // 相对 cwd，正斜杠
    style: 'line',                   // 见 STYLES
    anchor: 'function tick(',        // 或 null
    startLine: 11,                   // 1-based，begin 标记所在行
    endLine: 14,                     // 1-based，end 标记所在行
    code: 'console.log(...)',
    indent: '  ',                    // 实际施加的缩进
    label: 'dt',                     // 可选，写在 begin 标记里
    createdAt: '...'
  } ],
  scripts: [ { name: 'check', runtime: 'node', file: '.probe/scripts/check.mjs', createdAt: '...' } ],
  runs: [ { id: 'r1', label: '...', command: '...', exitCode: 0, durationMs: 12,
            probeLines: ['...'], recordFile: '.probe/runs/20261113-012700-check.json', createdAt: '...' } ],
  cleanedAt: undefined               // probe_clean 成功后写入
}
```

## 标记格式（关键契约，三个模块共用）

标记是**语言无关的载荷**，只靠注释符包起来：

```
// >>> dsh-probe begin p1 dt    (temporary; probe_clean removes this block)
   <探针代码>
// <<< dsh-probe end p1
```

- 载荷固定：`>>> dsh-probe begin <id> [label]` / `<<< dsh-probe end <id>`。
- 注释符按语言：`line` → `//`；`hash` → `#`；`dash` → `--`；`semi` → `;`；`rem` → `rem`；`block` → `<!-- ... -->`；`pct` → `%`；`quote` → `'`。
- **通用检测正则**（guard 扫描、clean 兜底都用它，忽略注释符）：

```js
export const MARKER_RE = /(>>>|<<<)\s+dsh-probe\s+(begin|end)\s+(p[\w-]+)/i
```

> T1 修正（2026-11-13）：原文的 `\b(>>>|<<<)` 永远匹配不到正常标记——`>` 是非单词字符，
> 前面是空格或行首时没有单词边界。去掉 `\b` 只放宽匹配范围，向后兼容；三个模块统一用上面这版。
> 捕获组顺序不变：`[1]` 开头符号、`[2]` begin|end、`[3]` id。

## 模块契约

### `lib/util.js`（Lead 已实现，直接用）

```js
export function ensureDir(dir)                          // mkdirSync recursive
export function readText(file)                          // 读不存在 → null；BOM 剥掉
export function writeText(file, text)                   // 原子写（tmp+rename），UTF-8 无 BOM
export function readJson(file, fallback)                // 坏/无 → fallback
export function writeJson(file, value)                  // 原子写，2 空格
export function sha256(input)                           // string|Buffer → hex
export function nowIso()
export function makeId(prefix)                          // 'pr-20261113-0127-ab12'
export function isPlainObject(v)
export function insidePath(root, target)                // target 在 root 内（含 root 本身 false）
export function toAbs(base, p)
export function relPosix(root, target)                  // 正斜杠、相对 root
export function slugify(s)                              // 安全文件名，最长 40
export function tailText(text, maxLines, maxChars)      // 截尾，带 '... (truncated)'
export function jsonSafe(v)                             // 环形/undefined 安全
export function lineCount(text)
export function sortKeys(obj)
```

### `lib/project.js`（Lead 已实现）

```js
export const PLUGIN_DIR
export const DEFAULTS = { dataDir: '.probe', ledgerFile: 'PROBE.md', defaultTimeoutSec: 120,
                          maxOutputBytes: 1048576, maxScanBytes: 2097152, maxRuns: 200,
                          exclude: ['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'], powershell: undefined }
export function resolveCwd(ctx, exec, args)             // 同 perf-opt 语义
export async function loadOptions(cwd, pluginConfig)    // 合并 .probe 配置（probe-opt.json）
export function resolvePaths(cwd, options)              // 返回 {root,dir,sessionFile,baselineDir,scriptsDir,runsDir,tmpDir,ledgerJson,ledgerFile}
export function numberIn(value, fallback, min, max)
export function oneOf(value, allowed, fallback, name)
```

### `lib/store.js`（Lead 已实现）

```js
export function probePaths(cwd)                         // 同 resolvePaths 的一份便捷版
export function loadSession(cwd)                        // session | null
export function saveSession(cwd, session)               // 创建目录 + 写
export function ensureSession(cwd, options, {label})    // → {session, created}；惰性初始化/clean 后开新轮
export function makeSessionId()                         // 'pr-YYYYMMDD-HHMMSS-rand'
export function requireSession(cwd)                     // 旧接口：无会话 → throw（工具层已改用 ensureSession）
export function baselineFile(cwd, rel)                  // .probe/baseline/<rel 转 __>
export function saveBaseline(cwd, session, rel, text)   // 首次才写；返回是否新写
export function loadBaseline(cwd, rel)                  // text | null
export function nextProbeId(session)                    // p1...
export function nextRunId(session)
export function touchSession(session)                   // 更新 updatedAt
```

### `lib/markers.js`（T1）

```js
export const STYLES = { line: {open:'//', close:''}, hash:{open:'#',close:''}, dash:{open:'--',close:''},
                        semi:{open:';',close:''}, rem:{open:'rem',close:''}, pct:{open:'%',close:''},
                        quote:{open:"'",close:''}, block:{open:'<!--',close:'-->'} }
export const MARKER_RE                                 // 见上
export const EXT_STYLE                                 // {js:'line', ts:'line', py:'hash', html:'block', lua:'dash', ...}
export function styleForFile(file)                     // 扩展名 → STYLES 键；未知 -> 'line'
export function commentOpen(style)                     // '//' 等
export function beginLine(style, id, label)            // 完整一行
export function endLine(style, id)                     // 完整一行
export function findMarkers(text)                      // [{line, index, type:'begin'|'end', id, text}]
export function hasMarkers(text)                       // bool
export function stripMarkers(text)                     // {text, removed:[{id,startLine,endLine,lines}], residuals:[{line,id,type}]}
                                                       // 残块（有 begin 无 end 等）不抛错，进 residuals
export function firstMarkerLine(text)                  // 行号 | 0
```

要求：`stripMarkers` 结果必须幂等；`text` 末尾换行风格要跟原文一致（CRLF 保留）；不吞掉标记块外的任何字节。

### `lib/insert.js`（T1）

```js
export async function insertProbe({ cwd, session, file, code, anchor, line, position, label, indent, create })
// → { file, probe, summary }
// file 相对 cwd（也接受绝对路径）；必须 insidePath(cwd, abs)
// position: 'after'(默认)|'before'（仅 line 模式）
// anchor 模式：必须唯一匹配，否则报错并列出候选行号与内容
// code 含 'dsh-probe' → 报错；code 空 → 报错
// indent: 'anchor'(默认)|'none'|<字符串>；施加到每一非空行
// 定位都不给：文件已存在 → 报错；create 新建 → 追加到文件末尾（换行补齐）
// create 新建的文件：基线记「注释头 + 空行」骨架（clean 剥掉块后正好逐字节等于它）
// 同一文件里已有同一 id 的标记 → 报错（防止重复插入搞坏文件）
// 失败不写文件（先算好再写）
export async function inspectFile({ cwd, file })       // {lines, markers, probeIds}
```

### `lib/runner.js`（T2）

```js
export function extractProbeLines(stdout)              // 约定：[probe] 前缀行，或 PROBE| 前缀行
export async function runCommand({ cwd, command, timeoutSec, env, collect, label, signal })
// command: string（走平台 shell）| string[]（直接 spawn，首选）
// → { exitCode, signal, durationMs, stdout, stderr, probeLines, truncated, timedOut }
export async function runScript({ cwd, session, name, args, timeoutSec, signal })
// 按 session.scripts 里登记的 runtime 组命令并跑；未登记 → 报错
export function runtimeCommand(runtime, file, args)    // node -> ['node', file, ...] 等
export function writeRunRecord(paths, session, run)    // 写 .probe/runs/<ts>-<slug>.json，返回相对路径
```

要求：超时必须真的杀掉进程树（Windows 用 `taskkill /pid /T /F`，其余 SIGKILL）；输出超过 `maxOutputBytes` 截断并标记；`exitCode` 非 0 不抛错（工具要把失败当信息交回）。

### `lib/scripts.js`（T2）

```js
export async function createScript({ cwd, session, name, runtime, body, force })
// runtime: 'node'|'python'|'powershell'；'auto' 按 name 后缀猜；默认 'node'
// → { script, file, created }
export function listScripts({ cwd, session })          // [{name, runtime, file, bytes, markers}]，markers=该脚本里是否有探针标记
export function showScript({ cwd, session, name })     // {name, runtime, file, text}
export function removeScript({ cwd, session, name })   // 从磁盘删 + session 摘除
```

脚本模板要求：带一行 `dsh-probe script: <name>（临时，probe_clean 会删）`；自带参数解析；演示 `[probe]` 输出约定；node 用 `.mjs`。

### `lib/guard.js`（T3）

```js
export async function guardScan({ cwd, scope, paths, options })
// scope: 'worktree'(默认)|'staged'|'all'
// → { ok, offenders:[{file, line, text, id}], trackedProbeDir:boolean, scannedFiles, warnings:[] }
// worktree: 已跟踪 + 未跟踪未忽略（git ls-files --cached --others --exclude-standard）；
// 非 git 仓库 → 递归遍历，跳过 options.exclude 与 .probe/baseline
// 只扫 ≤ maxScanBytes 的文本文件（二进制探测：含 NUL 跳过）
export async function residualScan({ cwd, session })
// 只针对 session.probes 的文件，列出残留标记；供 probe_clean 复核
```

### `lib/report.js`（T3）

```js
export function appendLedger({ cwd, paths }, entry)    // {id, question, method, findings, verdict, notes}
// verdict: 'explained'|'refuted'|'inconclusive'
// 写 .probe/ledger.json 数组 + 追加 PROBE.md 小节；返回 {id, file, entry}
export function listLedger({ paths }, { limit })
export function ledgerSummary({ paths })               // {total, byVerdict, last}
```

### `lib/guide.js`（Lead）

`guide(section, args)` → string；section ∈ `workflow|markers|scripts|run|clean|guard|pitfalls|languages|all`。

### `index.js`（Lead）

9 个工具：`probe_begin` `probe_status` `probe_insert` `probe_script` `probe_run` `probe_clean` `probe_guard` `probe_report` `probe_guide`，外加 runtime skill `probe`。

**初始化是惰性的**：`probe_insert` / `probe_script action=new|rm` / `probe_run` 在会话不存在（或上一轮已 `cleanedAt`）时先调 `ensureSession` 自建，并在 summary 里说明；只读操作（`probe_status`、`probe_script action=list|show`、`probe_guard`、`probe_guide`）不创建任何状态。`probe_begin` 只负责写 goal：会话存在就收编（同一 id），`reset=true` 才开新会话。

## 测试约定

- 用 `node --test test/*.test.mjs`（node:test + node:assert/strict）。
- 每个用例在 `os.tmpdir()` 下建唯一临时项目目录，结束删除；**不许写用户工作区**。
- 不依赖 git（git 相关路径要能在非 git 目录降级）。
- 中文用例名，失败信息要能定位。
