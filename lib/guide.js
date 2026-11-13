// probe 的 playbook。probe_guide 按 section 返回，skill 里也引用这些说法。
const SECTIONS = {}

SECTIONS.workflow = `# 探针流程（probe）

一次探针循环，五步，别跳步：

1. **probe_begin goal="我想知道什么"**
   写下问题，不是写下动作。「为什么第 3 帧的 hp 变成负的」比「加个打印看看」强一百倍——前者能判断成败。
   会话是**惰性初始化**的：换到新工作区后，第一个 probe_* 就会把 \`.probe/\` 建好；probe_begin 只是把问题记进去（收编同一个会话，不会重开）。

2. **插探针：probe_insert 或 probe_script**
   能改一小段源码就 probe_insert（一个文件一两行）；要跑独立逻辑、构造输入、遍历文件就 probe_script。

3. **probe_run 跑一次，读 [probe] 行**
   同一轮里改 → 跑 → 读，可以重复十几遍。探针一直留着，别拆。

4. **probe_clean 拆干净**
   它按基线拆，逐块删，不碰你在探针之外做的改动。

5. **probe_guard 过闸门，probe_report 记账**
   守卫拦住任何漏网的标记；账本记下「问题→结论」，因为探针会删，结论不会。

三句话总结：**探针是短命的，问题是长命的；先问对问题，再动手插；拆的时候要能证明拆干净了。**`

SECTIONS.markers = `# 标记格式

插进去的每一个块都长这样：

    // >>> dsh-probe begin <id> <label>    (temporary; probe_clean removes this block)
       console.log("[probe]", "<label>", JSON.stringify(state))
    // <<< dsh-probe end <id>

- 载荷固定：\`>>> dsh-probe begin <id> [label]\` 与 \`<<< dsh-probe end <id>\`，其它文字无所谓。
- 注释符按语言自动选：js/ts/c/cpp/cs/java/go/rust → \`//\`；python/sh/yaml/rb/ps1 → \`#\`；
  html/vue/svelte/xml/md → \`<!-- -->\`；lua/sql → \`--\`；ini → \`;\`；bat → \`rem\`。
- id 由插件分配（p1、p2……），**不要手写标记**——guard 会拦，clean 也配不上块。
- 块里不要出现字符串 "dsh-probe"，否则新一轮检测会把它当标记。

为什么用注释包裹：任何语言都合法、任何 diff 都能看见、任何 grep 都能找到，而且删的时候只靠行号区间，不靠语义。`

SECTIONS.scripts = `# 临时脚本（probe_script）

临时验证脚本的痛点是「写一次就散落一地」。这里给它一个固定家：\`.probe/scripts/\`。

- \`probe_script action=new name=repro runtime=node\` → 生成带参数解析的模板
- \`probe_script action=new name=repro body="..."\` → 直接写自己的
- \`probe_run script="repro" args=["--n","5"]\` → 跑
- \`probe_clean\` → 连脚本一起删掉（\`keepScripts=true\` 可以留）

**输出约定**：脚本里每一行以 \`[probe]\` 开头（也接受 \`PROBE|\` 别名，大小写不敏感），probe_run 就会把它单独抽出来，放在结果最上面。其余输出进记录的 tail，不占摘要。

    console.log('[probe]', 'n=' + n, 'sum=' + sum)      // node
    print('[probe] n=%d sum=%d' % (n, sum))              // python
    Write-Output "[probe] n=$N sum=$SUM"                 // powershell

三种 runtime 都可以；python 需要机器上有 python，powershell 只在 Windows 上。`

SECTIONS.run = `# probe_run 语义

- \`command\` 可以是 argv 数组（首选，没有 shell 转义问题）或一行字符串（走平台 shell）。
- \`script\` 是 probe_script 登记过的名字，自动选 runtime，自动带 \`.probe/scripts/\` 路径。
- **退出码非 0 不是错误**，是结果。工具把 exitCode 交回来，让你自己判断「崩了」还是「测出问题了」。
- 超时（默认 120s，可传 timeoutSec）会**杀掉整棵进程树**（Windows: taskkill /T /F），并标记 timedOut。
- 输出超过上限会截断并标记 truncated；\`[probe]\` 行从完整输出里抽取，不受截断影响。
- 每次运行都写 \`.probe/runs/<时间戳>-<slug>.json\`：命令、退出码、耗时、探针行、stdout/stderr 尾部。
  记录是证据，别删——尤其当你要向别人解释「我测过」。
- \`collect=false\` 可以只跑不抽行（用于被测程序自己输出太多探头的情况）。`

SECTIONS.clean = `# probe_clean 拆弹

拆的顺序是**先算、后写、再复核**：

1. 对每个被插过探针的文件：读当前内容 → 按标记区间删块 → 写回。
2. 跟基线比对：一致 = 逐字节还原；不一致 = 你在探针之外也改了这个文件，此时**只删探针块，别的改动保留**，并在报告里点名。
3. 删掉临时脚本。
4. 复核：再扫一遍，确认没有配不上的标记。
5. 写 \`cleanedAt\`，基线副本清掉。

参数：
- \`dryRun=true\` 先看计划，不动文件。
- \`purge=true\` 连 \`.probe/\` 一起删（runs/ 证据也删；\`purgeNotes=true\` 才删 PROBE.md）。
- \`keepScripts=true\` 留脚本。
- \`scanAll=true\` 连没登记的标记也清（危险但有用：手工插的残块）。

铁律：**报告的「与基线一致」才是还原，没这句话就说明有改动被保留了。**`

SECTIONS.guard = `# probe_guard 闸门

守卫只做一件事：确认没有探针标记会进提交。

- \`scope=worktree\`（默认）：已跟踪 + 未跟踪但未被忽略的文件。
- \`scope=staged\`：只看暂存区——提交前的最后一道。
- \`scope=all\`：两者并集。
- 有 git 用 \`git ls-files\`；不是 git 仓库就递归遍历（跳过 node_modules/.git/.probe）。
- 命中条件是**标记载荷**，不是字符串 "dsh-probe"。所以文档里提到这个词不会误报。
- 额外检查：\`.probe/\` 有没有被 git 跟踪。被跟踪了 → 警告，说明该把它加进 .gitignore。

建议放进提交流程：\`probe_guard scope=staged\` 不绿不提交。这等价于 perf-opt 里「闸门红就回滚」的位置。`

SECTIONS.pitfalls = `# 会真的踩到的坑

1. **探针比改动活得久。** 最常见的结局不是「没测出来」，是「测出来了，忘了删」。所以 guard 必须在提交前跑，别靠记性。
2. **在同一个文件里既插探针又改逻辑。** clean 会如实报告「其它行也变了」，但它分不清哪几行是你故意的——这两件事分成两次做。
3. **探针输出没加 [probe] 前缀。** 那就不会被抽出来，你会在一堆 stderr 里找它。约定就是约定。
4. **用探针代替调试器。** 能断点、能单步、能看调用栈的问题，探针是慢的那条路。探针擅长的是：跨进程、跨时间、批量、headless、跑一次要 30 秒以上。
5. **改一行插一个探针。** 一个会话里的探针超过 10 个，说明问题没想清楚。回去改 goal。
6. **依赖探针输出当断言。** 探针是临时的，别把「验证」写成只有探针存在时才成立。要长期成立的检查，进测试，不进探针。
7. **忘记 headless/CI 里的探针。** 探针插在共享代码里，CI 也会跑它。要么在 \`probe_run\` 里跑，要么保证探针是纯观测、无副作用。`

SECTIONS.languages = `# 各语言注意点

| 语言 | 注释符 | 注意 |
|---|---|---|
| JS/TS | \`//\` | 探针要放在语句位置，别塞进表达式中间；async 函数里注意别改变 await 顺序 |
| Python | \`#\` | 缩进跟 anchor 行走；探针放在函数体首行最容易删 |
| GDScript（Godot） | \`#\` | 探针写进 \`_process\` 会每帧刷；用计数器限流，否则 probe_run 记录会爆 |
| C/C++/Rust/Go | \`//\` | 别在宏定义中间插；Rust 注意 borrow 借用会让探针本身编译不过 |
| C#/Java | \`//\` | 探针里别 new 大对象，GC 会把性能测歪 |
| HTML/Vue/Svelte | \`<!-- -->\` | 只能插在模板层，插不到 script 逻辑里，那种情况用 JS 注释风格另插一处 |
| PowerShell | \`#\` | \`Write-Output "[probe] ..."\` 才进 stdout；\`Write-Host\` 在部分宿主里不走管道 |
| Shell | \`#\` | \`echo "[probe] ..." >&2\` 请明确走 stderr 还是 stdout |

通用：探针要**便宜**。纯读变量、拼一行字符串就够；不要在里面做 O(n) 遍历、不要 sleep、不要发网络请求。`

export function guide(section = 'workflow') {
  if (section === 'all') {
    return Object.values(SECTIONS).join('\n\n---\n\n')
  }
  return SECTIONS[section] ?? SECTIONS.workflow
}

export const SECTIONS_NAMES = Object.keys(SECTIONS)
