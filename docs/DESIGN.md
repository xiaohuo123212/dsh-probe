# dsh-probe 设计说明

`dsh-probe` 是 DeepSeek Harness 的一个插件：**改代码时的临时探针工作台**。

它把「插一段打印 → 跑一次 → 看一眼 → 删掉」这件人人都做、几乎人人都做不干净的事，做成一个有状态、有闸门、有账本的循环：9 个工具 + 1 个运行时 skill `probe`，纯 ESM，只依赖 `node:` 内置模块，工具定义用普通 JSON Schema 加手写校验（`requireText` / `oneOf` / `numberIn`），不 import 任何 Harness 包——因为它要能被 `link:` 进 profile 目录，靠 Harness 提供的一切都拿不到。

本文回答六个问题：为什么值得做、明确不做什么、机制为什么长这样、数据怎么流、边界在哪、和兄弟项目 `dsh-perf-opt` 是什么关系。文中出现的每个参数名、每个文件名，都在 `index.js` 或 `lib/` 里有对应实现。

---

## 1. 问题：临时探针为什么会烂在代码里

「加一行打印看看」是每个工程师的第二天性，也是最没有被工具化的一步。它的问题不在于难，而在于**它每次都从零开始，而且每次都不收尾**。可以分成四个失败模式，前三个是操作层面的，第四个是认知层面的，也是最贵的。

### 1.1 插不准

定位靠肉眼。函数重名、文件几百行、缩进深浅不一、CRLF 与 LF 混用、注释符每种语言都不一样（JS `//`、Python `#`、HTML `<!-- -->`、Lua `--`、bat `rem`、ini `;`），手写一次就要错一次。

更糟的是没有身份：插了三个探针，不知道哪一行属于哪一次实验；想拆某一个，只能靠肉眼找。如果 `anchor` 命中了多处而工具替你猜了一个，探针插进了错误的函数——这比没插更糟，因为它会给出一个看起来很像真的错误结论。

### 1.2 跑不动

临时脚本散落一地：这次写到项目根的 `check.mjs`，下次扔进 `/tmp`，再下次直接 `node -e`。然后忘了当初用什么命令跑的、参数是什么、cwd 是哪个。换一个 shell 引号规则就变，`command` 一行字符串在 cmd 和 bash 下的行为不一样。跑飞了不杀进程树，后台留一个还在写日志的进程。输出几千行，把上下文打爆，真正的证据淹没在 noise 里，你只能翻回去找。

### 1.3 删不干净

这是最贵的一类，因为它**不报错**。探针比改动活得久：改完、提交、上线，第二天在 diff 里看见一个 `console.log("here")`。

- 靠记性删 → 会漏；
- 靠正则删 `console.log` → 会误伤真正的日志；
- 手删 → 删完不知道自己删干净没有，也没有任何东西能证明。

「我删了」和「我能证明删了」之间差一个基线。

### 1.4 最贵的一种：结论没留住

一次探针循环的真实成本，主要在「想清楚问题 + 构造场景 + 跑」这三步。探针删掉之后，这三步的产物只剩下聊天记录里的一段输出，和当事人的记忆。

于是会发生两件很贵的事：同样的实验被不同的人（或同一个人隔两周）重做一遍；一个已经被**证伪**的假设，因为没有落账，又被重新相信一次。工具能帮的最小一件事，是让结论活得比探针长。

---

## 2. 不做什么

一个工具的价值一半来自它做了什么，一半来自它拒绝做什么。这四条是硬边界。

**不替代调试器。** 没有断点、单步、调用栈、变量监视、条件断点。能 attach 调试器解决的问题，探针是慢的那条路。探针真正的生态位是：跨进程、跨时间、批量、headless/CI、单次运行 30 秒以上的场景——以及「你根本进不去那个环境」。所以 `probe_guide` 里第一条 pitfall 就是「别用探针代替调试器」。

**不做断言框架。** 探针的输出是**事实**，不是**契约**。工具不提供「断言这个值等于 3」的语法，也不把探针输出变成通过/失败。需要长期成立的检查属于测试（`node:test` 之类），不属于探针。这个边界很重要：一旦探针承担断言职责，它就有了「不能被删掉」的理由，而「可以被随时删掉」正是探针的全部优点。

**不长期持有探针。** 探针的唯一正确归宿是被删掉。插件不提供「把这个探针保留成常驻日志」的路径，`probe_clean` 默认连临时脚本一起删。想留下的东西走 `probe_report` 进账本，不留在源码里。

**不做热重载、注入式 AOP、运行时插桩。** 不做 `require` 钩子、不做 monkey patch、不做 eBPF/SIMD 之类的活。插入是**文本的**：在某个文件的某一行前后，加一段被注释标记包起来、缩进对齐的代码。这个选择限制了能力（观测不到表达式内部、改不了已编译产物），换来了普适性（任何语言、任何构建系统、任何不用跑起来就能看的 diff）。

---

## 3. 核心机制

### 3.1 标记是注释载荷，不是语义插入

每一块探针长这样：

```text
// >>> dsh-probe begin <id> [label]    (temporary; probe_clean removes this block)
   console.log("[probe]", "hp", state.hp)
// <<< dsh-probe end <id>
```

载荷是固定的——`>>> dsh-probe begin <id> [label]` 与 `<<< dsh-probe end <id>`，id 由插件分配（`p1`、`p2`……），label 只是给人看的短标签——真正可变的部分只有注释符。注释符按扩展名选：`line`（`//`）、`hash`（`#`）、`dash`（`--`）、`semi`（`;`）、`rem`（`rem`）、`block`（`<!-- -->`）、`pct`（`%`）、`quote`（`'`）。

**为什么不做语义插入？** 语义插入（改 AST、在语句边界注入）需要每种语言一个 parser，还要处理版本差异、语法方言、模板内嵌脚本、宏。代价是 O(语言数 × 版本数)，而收益只是「看起来更聪明」。反过来，注释载荷有三个硬优点：

1. **在所有主流语言里都合法**，包括 HTML 模板、Shell、bat、Lua、SQL；
2. **在 diff 里一眼可见**，reviewer 不需要理解机制就能看出「这是一块临时探针」；
3. **删除只需要行号区间，不需要理解语义**。

第三点是决定性的。`stripMarkers` 不需要知道这门语言怎么解析，它只找一对载荷行，把中间的行整段切掉。这让「拆除」变成一个可以证明正确的字节操作，而不是一个依赖语言理解的启发式。

检测用的是**忽略注释符**的通用正则：

```js
/(>>>|<<<)\s+dsh-probe\s+(begin|end)\s+(p[\w-]+)/i
```

注释符怎么变都无所谓，载荷不变。guard 扫描、clean 兜底、残块识别，三处共用这一条判定——一处定义，三处一致。注意 `>>>` 前面不能加 `\b`：`>` 是非单词字符，前一个字符是空格时根本没有单词边界，加了 `\b` 整个正则一个字都匹配不上（实现里刻意去掉了）。

两个必须成立的实现约束：

- **幂等**：`stripMarkers` 对同一份文本跑两次，结果必须一致（clean 可能被重复执行，或 dry run 之后紧跟真跑）。
- **不吞字节**：标记块之外的任何字节都不能变，包括行尾风格（CRLF 保持 CRLF）。否则 clean 之后「与基线一致」这个判断会永远失败，而失败原因看起来像是用户的锅。

配对失败（有 begin 没 end、id 对不上）不抛错，进 `residuals`，由 clean 报告出来。工具不该因为文件里有一块坏掉的标记就整体罢工——那会让用户卡在一个连报错都修不了的角落。

### 3.2 基线 + 逐块外科式拆除：怎么证明「还原了」

`probe_insert` 第一次往某个文件插探针时，会把**插之前**的原文整份复制到 `.probe/baseline/`，并在 `session.json` 的 `baseline` 里记下 `sha256`、`bytes`、`lines`、`savedAt`。`saveBaseline` 只在首次写入——所以无论后面往同一个文件插 1 个还是 5 个探针，基线永远是「动手之前」的那一版，不会被后来的状态污染。

基线文件名是把相对路径里的分隔符换成 `__` 打平存放（`src/a.js` → `src__a.js`）。这样既不会在 `.probe/baseline/` 下再造一层镜像目录，也不会因为恶意相对路径（`../../etc`）逃出项目。用 `create=true` 新建出来的文件，基线取的是**刚写下的注释头骨架**（一行注释 + 一个空行），探针记录上带 `created: true`；clean 时如果拆完正好等于这个骨架，就把整份文件一起删掉——不会留一个 0 字节空壳，也不会把「骨架 vs 空字符串」的差异误报成「探针之外还有改动」。如果那个文件后来被写进了真内容（骨架已不成立），clean 只拆探针块、保留文件，并在报告里点名。

`probe_clean` 的算法就五步：

1. 对每个登记过的文件：读当前内容 → 按标记区间删块 → 写回；
2. 把结果与基线**整份逐字节比较**；
3. 相等 → 报告「与基线一致」，还原被证明；
4. 不等 → 只删探针块，其余改动**保留**，并在报告里点名「探针之外还有改动」；
5. 删临时脚本、复核残留、写 `cleanedAt`、丢掉基线副本。

第 4 步是这套设计里最不讨喜、也最重要的决定。工具**不替用户决定**哪几行是有意的改动。整文件回滚看起来很干净，但它会把探针期间做的真实修复一起抹掉——一次误伤就足以让人再也不信任这个工具。而「只删标记块」在任何情况下都是安全的：标记区间是行级的、由 id 唯一确定、删除是幂等的，所以哪怕文件里还有你手工加的三行逻辑，它也只会拿走它自己加的东西。

于是「拆干净了」这句话有了确切含义：**报告里出现「与基线一致」**。没有这句话，就说明有改动被保留了——这可能完全正确（你真的改了逻辑），也可能是个信号（有别的进程改了这个文件，见 §5.1）。这个「信号」有一半可以先一步看见：记录说探针还挂着、文件里其实已经没了（被人手工删了），或者文件里有标记、记录里没登记（手工插的），这类漂移由 `probe_status` 在 clean 之前曝光（见 §4.1）。

边界也要说清：没有基线（老会话、跨会话残留的标记）就不承诺逐字节还原，只保证标记被拿走，报告里 `matchesBaseline` 为 `null`。工具不假装自己证明了什么。

### 3.3 `[probe]` 前缀：把过滤做在输出端

探针输出约定：一行以 `[probe]` 开头，`probe_run` 就会把它抽出来放在结果最前面；其余输出进记录与摘要的尾部。三种 runtime 都只要一行：

```js
console.log('[probe]', 'n=' + n, 'sum=' + sum)   // node
print('[probe] n=%d sum=%d' % (n, sum))           // python
Write-Output "[probe] n=$N sum=$SUM"              // powershell
```

**为什么不解析日志？** 因为解析日志要求工具知道：这是什么 logger、级别前缀长什么样、是不是 JSON、有没有颜色码、进程之间输出会不会交织。每加一种被测程序就要加一条规则，而规则错了会静默漏掉证据。更糟的是，为了让解析器工作，探针作者得把输出写成机器可解析的形状——那就已经是在写断言了。

前缀约定把复杂度放在最小的地方：**探针作者记住一个字符串就够了**。过滤发生在抽取阶段，不需要正则，不需要 schema，不会因为被测程序换了个 logger 就失效。实现里还额外认 `PROBE|` 前缀（大小写不敏感、允许前导空白），作为某些语言里不好写方括号时的等价写法；文档和模板仍然只推荐 `[probe]`。

「抽出来」不等于「丢掉其它」：stdout/stderr 的尾部（默认截到 200 行 / 20000 字符）仍然写进 `.probe/runs/<ts>-<slug>.json`，摘要里再截一层。这是分层，不是丢弃——真正需要翻原始输出时，记录在。

抽取发生在完整输出上，截断只作用在摘要里的 tail，所以 `[probe]` 行不会因为 stdout 太长而消失。这条设计让「跑一个输出很吵的程序」不再是赌博。

### 3.4 guard 按载荷命中，不按字符串

`probe_guard` 的命中条件是标记载荷（`>>> dsh-probe begin <id>` / `<<< dsh-probe end <id>`），**不是**字符串 `dsh-probe`。

这个区别不是洁癖。这个插件自己的 README、这个设计文档、`probe_guide` 的正文里都会大量出现 `dsh-probe` 这个词。如果按字符串判定，插件会把自己拦下来，而一个会误报自己的守卫，用户第二次就会开始忽略它。

代价是：**形状正确的手写标记也会被拦**。这是特性不是缺陷——手写标记恰好是 `clean` 配不上块的那一类（它进不了 `session.probes`），也正是最需要被拦下的一类。

扫描范围由 `scope` 决定：

| scope | 取哪些文件 | 用途 |
|---|---|---|
| `worktree`（默认） | `git ls-files --cached --others --exclude-standard`：已跟踪 + 未跟踪但未被忽略 | 日常自查 |
| `staged` | `git diff --cached --name-only`：只在暂存区 | **提交前的最后一道** |
| `all` | 上面两个的并集 | 全面体检 |

没有 git（或不是仓库）时降级为递归遍历，跳过 `options.exclude` 与 `node_modules` / `.git`。这个降级是必须的：很多用户的临时项目、Godot 工程、单文件脚本目录根本不是 git 仓库，而探针照样会插进去。

扫描策略里有三条容易被问到的取舍：

- **跳过整个 `.probe/`**。会话文件、基线副本、run 记录里都会抄到探针源码和标记样例，扫它等于每轮都自伤。
- **跳过项目根的 `CONTRACT.md`**。它是这个插件的实现契约，天然自带标记格式示例。
- **其余文件照扫**，包括 `README.md` 和 `skill/`。宁可让作者把示例写进契约文档，也不静默跳过用户项目里真正叫 `docs/` 的代码目录。这也是为什么本文和 README 里的标记示例都用 `<id>` 占位符而不是真实 id——写了真实 id，`probe_guard` 会（正确地）把它们当成残留。

易用性上的两个细节：含 NUL 的文件当二进制跳过；超过 `maxScanBytes`（默认 2 MiB）的文件跳过并给 `warning`。所以「绿」永远附带「扫了多少个文件」——一个扫了 3 个文件的绿，和一个扫了 3000 个文件的绿，不应该看起来一样。

额外的检查：`.probe/` 有没有被 git 跟踪。被跟踪了就给 warning（见 §5.4）。

闸门的位置很明确：提交前 `probe_guard scope=staged`。这在整套设计里等价于 `dsh-perf-opt` 里「闸门红就回滚」的那个位置——唯一的区别是一个防「性能没变好」，一个防「调试代码进了版本库」。

### 3.5 账本：探针短命，结论长命

探针在**成功路径上**必然被删掉。所以结论不能住在探针里，也不能只住在聊天记录里。

账本有两份，同一份数据的两个投影：

- `.probe/ledger.json`：结构化数组，给程序和 `probe_report action=list|summary` 用；
- `PROBE.md`（项目根）：人读版，每次 append 一节 markdown。

id 是 `Q-1`、`Q-2`……编号在写入时算，撞了就递增。verdict 三态：`explained`（解释通了）、`refuted`（证伪了）、`inconclusive`（没结论，但值得记）。

`refuted` 与 `explained` 等值，这是账本存在的第二个理由。工程上最贵的一类浪费是**反复验证同一个被证伪的假设**：「不是缓存导致的」这句话写下来，下一个人才不会又花两小时去查缓存。

第三条规矩：`PROBE.md` 不会被 `probe_clean` 删。只有显式 `purge=true` + `purgeNotes=true` 才删。探针是短命的，结论不是——如果清场时连结论一起清掉，那这套工具就退化成了一个更花哨的 `console.log`。

---

## 4. 数据流

### 4.1 一次探针循环的时序

```text
任意 probe_* 首次调用（或显式 probe_begin goal=...）
  └─ ensureSession：建 .probe/{session.json,baseline/,scripts/,runs/,tmp/}
     session = {version:1, id:'pr-<日期>-<时分秒>-<rand>', goal:null, autoStarted:true,
                probes:[], scripts:[], runs:[], baseline:{}}

probe_begin goal=...
  └─ 会话已存在（autoStarted 或已有内容）：收编同一 id，只补 goal/label，不重开
     要放弃现存探针另起一轮，才用 reset=true

probe_status                    ← 只读：随时对账，不算一步
  └─ 会话摘要 + 每个文件的 live 探针（id 与行区间）+ drift 列表

probe_insert file=... anchor=... code=...
  ├─ 校验：code 非空、不含 'dsh-probe'、anchor 唯一命中（否则报错并给候选行号）
  ├─ 首次给该文件拍基线 → .probe/baseline/<打平路径> + session.baseline[rel]
  ├─ 写源码：begin 标记 + 缩进后的探针代码 + end 标记
  └─ session.probes.push({id:'p1', file, startLine, endLine, ...})

probe_script action=new ...
  └─ .probe/scripts/<name>.<ext> + session.scripts.push(...)

probe_run command=[...] | script=...
  ├─ spawn（argv 数组）或走平台 shell（字符串）
  ├─ 超时 → 杀整棵进程树，标记 timedOut
  ├─ 抽 [probe] 行；超长输出截断并标记 truncated
  ├─ 写 .probe/runs/<ts>-<slug>.json（命令、退出码、耗时、探针行、stdout/stderr）
  └─ session.runs.push({id:'r1', exitCode, durationMs, probeLines, recordFile, ...})

        ↑______ 改 → probe_run → 读 [probe] 行，重复任意次 ______|

probe_clean [dryRun]
  ├─ 每个登记文件：stripMarkers → 写回 → 与基线逐字节比较
  ├─ 删临时脚本（keepScripts 可留）
  ├─ residualScan 复核（只看本会话动过的文件）
  └─ cleanedAt = nowIso()，丢基线；purge 时删整个 .probe/

probe_guard scope=staged
  └─ 只读：offenders[] 或 ok=true + scannedFiles

probe_report action=append
  └─ .probe/ledger.json 追加 + PROBE.md 追加一节
```

`probe_status` 是这张图里唯一一个「不改变任何状态」的入口，但它不是装饰：它把 `session.probes` 与磁盘上的标记做一次对账，把四类漂移列出来——文件已不存在、记录说 `p3` 还挂着但文件里找不到（手工删了？）、文件里有 `p5` 但会话没登记（手工插的？`probe_clean scanAll=true` 可清）、以及探针数超过 10 的警告。这是 clean 之前**唯一能看见状态**的地方：clean 只按记录拆，记录和文件一旦分叉，看报告才知道；而 `probe_status` 让人在动手前就知道会拆掉什么、还剩什么。

关键性质：**所有工具共享同一份事实** `session.json`，没有隐藏的进程内状态。所以 CLI、Desktop、子代理、换个窗口接着做，看到的是同一个会话。会话一旦 `cleanedAt`，下一轮任意 `probe_*` 会直接开新会话（`ensureSession`），不需要先 `probe_begin`——「这轮结束了」是个状态，不是记忆；旧一轮没拆的探针也不会被悄悄继承，只会在 `probe_status` / `probe_guard` 里显形。

### 4.2 `.probe/` 里每个文件的生命周期

| 路径 | 谁写 | 谁读 | 谁删 |
|---|---|---|---|
| `.probe/session.json` | `ensureSession` 创建（首次任意 `probe_*`，或 `probe_begin`）；`probe_insert` / `probe_script` / `probe_run` / `probe_clean` 更新（`probe_report` 只写账本，但会话没有 goal 时会顺手补上） | 所有工具入口（`loadSession`），`probe_status` 还拿它和文件对账 | `probe_clean purge=true` 删整个目录；否则一直留着（`cleanedAt` 标记这轮已结束） |
| `.probe/baseline/<打平路径>` | `probe_insert` 首次插该文件时写一份 | `probe_clean` 比对 | clean 成功后 `dropBaseline` 逐个删；`purge=true` 整目录删 |
| `.probe/scripts/<name>.<ext>` | `probe_script action=new`（模板或 `body`；`force` 时旧版备份到 `tmp/`） | `probe_run script=` / `probe_script action=show|list` / `probe_status` 计数 | `probe_clean`（默认删，`keepScripts=true` 保留）；`probe_script action=rm` |
| `.probe/runs/<ts>-<slug>.json` | `probe_run` 每次都写 | 人读；`probe_status` 只取最近一条做摘要 | 只有 `probe_clean purge=true` 删（证据默认保留） |
| `.probe/tmp/` | `ensureSession` 建；原子写与脚本覆盖备份的中转站 | — | 手动；`purge=true` |
| `.probe/ledger.json` | `probe_report action=append` | `probe_report list` / `summary` / 接着 append；`probe_status` 读条数 | `purge=true` 删（`purgeNotes` 只影响 `PROBE.md`） |
| `PROBE.md`（项目根） | `probe_report action=append` 追加一节 | 人读 | 只有 `purge=true` + `purgeNotes=true` 才删 |

四条需要强调的：

1. **基线只写一次**，后面永不覆盖——这是「拆了能证明」的基础。
2. **run 记录不随 clean 消失**。它是「我测过」的证据，`clean` 的职责是清源码，不是销毁证据。`session.runs` 超过 `maxRuns`（默认 200）时只丢最旧的**引用**，磁盘上的 json 不动——这是一个 200 条的「最近列表」，不是留存上限。
3. **`purge=true` 是唯一会删掉 run 记录的操作**，它连 `.probe/` 整个目录一起删；默认情况下 `PROBE.md` 留着，除非再加 `purgeNotes=true`。
4. **`scripts/` 是临时目录**，不是「我的脚本收藏夹」。想长期留的脚本应该进项目自己的 `tools/` 或测试目录——但那就不是探针了。

### 4.3 配置与路径约束

项目根可以放一个 `probe.json`，覆盖 `DEFAULTS` 里的键：`dataDir`（默认 `.probe`）、`ledgerFile`（默认 `PROBE.md`）、`configFile`、`defaultTimeoutSec`（120）、`maxOutputBytes`（1 MiB）、`maxScanBytes`（2 MiB）、`maxRuns`（200）、`exclude`、`powershell`。插件配置里同名的键优先级更低，项目文件优先。

所有落盘路径都过 `resolvePaths`：`dataDir` 必须解析到项目内且不能等于项目根，`ledgerFile` 必须留在项目内。这条约束挡住最常见的两种事故：把 `dataDir` 配成 `.`（clean 会开始删项目文件），把 `ledgerFile` 配成绝对路径（账本跑到项目外面去）。

工具自身的执行超时与进程超时是两层：`probe_run` 的进程超时由 `timeoutSec`（默认 120s）控制，工具级 `timeoutMs` 给到 30 分钟；`probe_clean` / `probe_guard` 各 10 分钟——它们可能扫几千个文件。`probe_status` 是纯读取，30 秒就够。

---

## 5. 边界与风险

这一节列的是**已知的、不打算修的**边界。写出来是因为用户有权知道工具在哪不设防。

### 5.1 直接写源码，绕过 Harness 的文件版本守卫

`probe_insert` 和 `probe_clean` 用 `fs` 直接读写源文件，不走 Harness 的 `read` / `edit` 工具——那里有文件版本守卫（并发编辑会返回 `FS_STALE_VERSION` 并让你重读）。探针块是按行号精确计算的，中间没有人工确认的机会，所以只能直接写。

后果很直接：

- **同一个文件不要并行改。** 插探针期间让别的 agent、别的编辑器、别的脚本同时写它，最后写入者赢，探针块可能被吃掉一半（于是变成 `residuals`），或者你的改动被覆盖。
- **一个文件插完立刻跑。** 探针留在树上的时间越长，被别的写者碰到的概率越高。
- **多文件就串行。** 这不是性能问题，是正确性问题。

插件能做的是：请求非法时**一个字节都不写**（先算好再落盘）、写文件用原子写（tmp + rename）、clean 时如实报告「其它行也变了」。它做不到的是替你协调并发写者。`probe_status` 的 drift 列表能让你在 clean 之前就发现「记录里的行区间已经对不上」，但它改变不了「最后写入者赢」这个事实。

### 5.2 探针在 CI 和 headless 下也会跑

探针是**源码**，不是调试会话。谁跑这份代码，谁就跑到探针——包括 CI、包括无头回归、包括别人的机器。

所以规则不是「记得删」，而是**探针必须是纯观测**：不改状态、不做 IO、不发网络请求、不 sleep、不做 O(n) 遍历。一个会写入的探针，如果漏到 CI 里，就是一次数据损坏，而不仅仅是几行多余输出。

限流也要考虑：插在 `_process` / `update` 这类每帧/每 tick 调用的函数里，输出会按帧数爆炸，run 记录会变成几百 MB。计数限流（每 100 次打一行）是探针作者的责任，工具不替你做。

唯一的防线是闸门：`probe_guard scope=staged` 不绿不提交。`probe_clean` 自己也会做一次复核（`residualScan`），但它只复核本会话登记过的文件——跨会话、手工插的标记，只有 guard 能兜住。

### 5.3 Windows 上的差异

Windows 是主要目标平台，但代码不能假设 Windows（只有 `install/` 下的 ps1 例外）。三个与平台相关的行为差异：

- **杀进程树**。超时必须真的杀掉整棵进程树，否则探针会挂在后台继续跑、继续写日志，而你以为它停了。Windows 用 `taskkill /pid <pid> /T /F`，其它平台发 `SIGKILL`。
- **`command` 的两种形态**。传字符串就走平台 shell——cmd 的引号规则和 POSIX 不一样，同一行命令在两边不等价；传 argv 数组则直接 spawn，没有转义问题。所以文档里永远推荐数组，字符串留给「我就是要用 shell 特性」的场景。
- **行尾**。`stripMarkers` 写回时行尾风格必须跟原文一致（CRLF 保持 CRLF）。否则 clean 之后整份文件「与基线不一致」，而这个不一致是工具自己造的，会让用户彻底失去对报告的信任。

还有一条不是平台的锅但相关：基线按 `__` 打平存放，理论上 `src/a/b.js` 和 `src__a__` 这类构造可能撞名。概率极低，但知道存在比假装不存在好。

### 5.4 `.probe/` 必须进 `.gitignore`

里面的东西对别人没有意义，而且有实际风险：`runs/` 记录会抄到探针源码和程序输出，`baseline/` 是源码副本，`session.json` 里有你的文件路径。抄进版本库等于把调试残渣永久化。

插件自带的 `.gitignore` 里已经有 `.probe/`；`probe_guard` 会额外检查「`.probe/` 是否已被 git 跟踪」，命中就给 warning。这是唯一一条「工具主动管用户仓库卫生」的检查——因为一旦基线副本进了版本库，后面所有 clean 的比对都会变得可疑。

清场时想清楚要留什么：`purge=true` 连 runs 证据一起删，`purgeNotes=true` 才删 `PROBE.md`。默认是「删探针、留证据」。

### 5.5 扫描与统计的盲区

- **二进制文件**（含 NUL）不扫；**超大文件**（> `maxScanBytes`，默认 2 MiB）不扫，只给 warning。所以「绿」的含义是「扫过的都干净」，不是「宇宙里没有」。
- **`exclude` 里的目录**（`node_modules`、`dist`、`build`、`.venv`、`__pycache__` 等）不扫。命中数可能因此被低估。
- **anchor 歧义时报错，不猜**。猜错比报错贵得多：报错只是多一次调用，猜错是一个假结论。
- **文件在 insert 与 clean 之间被删或改名**：clean 报告「文件已不存在」，不去找回来。它不知道文件去哪了，也不该猜。
- **会话外的标记**：`probe_clean` 只拆自己登记的；`scanAll=true` 才顺带清掉工作区里其它带标记的文件（危险但有用：手工插的残块）。这类残块 `probe_status` 不会列成 drift——drift 只对账本会话登记过的文件，工作区里别的文件归 `probe_guard` 管。
- **探针超过 10 个**：不是工具限制，是信号——问题没想清楚。回去改 `goal`。

---

## 6. 与 dsh-perf-opt 的关系

同一个作者、同一类插件、同一种写法：纯 ESM、只依赖 `node:` 内置、普通 JSON Schema 加手写校验、工具统一返回 `{summary, result}`、外加一个运行时 skill。两者的 `install/install.ps1`、`cordis.patch.yml`、`link:` 安装方式都是同一套。

**分工**：

- `dsh-perf-opt` 管「改动到底**值不值**」——先冻结 golden，交错 A/B，过闸门，记账；
- `dsh-probe` 管「改动到底**做了什么**」——先拍基线，插探针，跑，拆，记账。

一个问的是「快了多少」，一个问的是「到底发生了什么」。日常开发里，通常是 probe 在前（搞清楚机制），perf-opt 在后（确认改动有收益）；也可以是 perf-opt 的 A/B 结论解释不通时，回头用 probe 看内部状态。

**闸门思想一致**：

| | dsh-perf-opt | dsh-probe |
|---|---|---|
| 改前冻结 | `perf_gate action=capture` / `perf_snapshot action=create` | `probe_insert` 自动拍基线 |
| 现状可见 | `perf_gate action=status` / `perf_record action=list` | `probe_status` |
| 闸门 | `perf_gate action=run` 全绿才保留 | `probe_guard scope=staged` 绿了才提交 |
| 红了的动作 | 回滚改动 | `probe_clean` 拆掉重来 |
| 否决/证伪也记账 | `perf_record`（rejected 方向最值钱） | `probe_report`（refuted 同样值钱） |

两边都不是「让模型更会写代码」，而是**让模型无法用感觉代替证据**：改前有基线，改后有比对，结论必须落盘。区别只在于证据的种类——一边是毫秒数与 `.text` 哈希，一边是 `[probe]` 行和「与基线一致」这句话。

一句话总结：**perf-opt 证明你的改动值得留下；probe 证明你的改动到底做了什么，而且没留下别的东西。**
