# 临时探针工作台（probe）

当用户要求「打印一下看看 / 加日志调一次 / 复现这个 bug / 验证改动真的生效 / 确认调试代码没留在提交里」时使用本流程。
核心思想：**探针短命，问题长命**——先问对问题，再动手插，拆的时候要能证明拆干净了。

## 可用工具

- `probe_begin`：给当前会话写 `goal`（一句话说清要弄清什么）。**不是必须先调**——换到新工作区时，第一个 `probe_*` 会自动建好会话；`probe_begin` 会收编那个会话只补 goal，不会重开。要放弃现有探针另起一轮才用 `reset=true`。
- `probe_status`：看现在挂了什么——每个探针的 `file` 与行区间、临时脚本、运行记录条数、账本条数，以及「记录里有、文件里已没有」的漂移（被手工删了或手工插了）。插下一个之前、clean 之前各看一次。
- `probe_insert`：往源码插一个带标记的探针块；`file` + `code` 必填，定位用唯一 `anchor` 或 1-based `line`（配 `position=after|before`），`indent` 默认跟随锚点，`create` 允许新建文件；同时拍下该文件基线。
- `probe_script`：临时脚本的家；`action=new|list|show|rm`（默认 list），`name`，`runtime=node|python|powershell|auto`（默认 node），`body` 不给则用模板，`force` 覆盖旧脚本。
- `probe_run`：跑一次并收结果；`command`（argv 数组首选）或 `script` + `args`，`timeoutSec` 默认 120，`env`，`collect` 默认 true，`label` 进记录文件名。超时会杀掉整棵进程树（退出码 124）；退出码非 0 是结果不是错误。
- `probe_clean`：按基线拆探针、删临时脚本、复核残留；`dryRun` 只看计划，`keepScripts` 留脚本，`purge` 连 `.probe/` 一起删，`purgeNotes` 再删 `PROBE.md`，`scanAll` 连没登记的标记也清。
- `probe_guard`：找残留标记并给出 `file:line`；`scope=worktree|staged|all`（默认 worktree），`paths` 可限定范围。提交前必跑。
- `probe_report`：记账；`action=append|list|summary`（默认 append），append 需要 `question`，另有 `method` / `findings` / `verdict=explained|refuted|inconclusive` / `notes`，`limit` 控制 list 条数。
- `probe_guide`：规则正文；`section=workflow|markers|scripts|run|clean|guard|pitfalls|languages|all`。

## 必须遵守

1. **先写 goal 再插探针。** 初始化是自动的（任意 `probe_*` 首次调用就建好 `.probe/`），但「我要弄清什么」不会自动出现：先 `probe_begin goal="..."`，否则插完只能靠事后回忆。没有 goal 的探针，测了也不知道测出了什么。
2. **探针输出统一 `[probe]` 前缀**，比如 `console.log("[probe]", "hp", state.hp)`。没有前缀就不会被抽出来，你只会在整屏输出里找它。
3. **同一个文件不要既插探针又改逻辑。** clean 分不清哪几行是你故意的，只会报告「探针之外还有改动」。这两件事分成两次做。
4. **不要手写标记，块里也不要出现字符串 `dsh-probe`。** id 由插件分配（p1、p2……）；手写的标记 guard 会拦、clean 也配不上块。
5. **探针是纯观测：** 不改状态、不 sleep、不发网络请求、不做 O(n) 遍历。探针在源码里，CI 和 headless 也会跑到它。
6. **能断点、单步、看调用栈解决的问题别用探针。** 探针擅长跨进程、跨时间、批量、headless、单次跑 30 秒以上的场景。
7. **一个会话的探针超过 10 个，先回去改 `goal`**（直接 `probe_begin goal="..."` 覆盖，会话还是同一个；只有要丢掉现有探针时才 `reset=true`）。数量是「问题没想清楚」的信号，不是工具上限。
8. **提交前 `probe_guard scope=staged` 必须为绿。** 不绿不提交，不要靠记性——探针比改动活得久，这是最常见的翻车方式。
9. **收尾必须 `probe_clean`，并确认报告里出现「与基线一致」。** 没有这句话，就说明还有改动被保留着，别当成已还原。
10. **结论必须进 `probe_report`。** 探针会被删掉，结论不会：写清 question / method / findings / verdict，refuted 和 explained 一样值钱。

## 默认流程

1. `probe_begin goal="我想知道什么"`：写问题，不写动作。会话不存在时它顺手建一个，存在就收编。「为什么第 3 帧 hp 变成负的」比「加个打印看看」可判断得多。
2. 插探针：改一小段源码用 `probe_insert`；要跑独立逻辑、构造输入、遍历文件用 `probe_script`。
3. `probe_run` 跑一次：优先传 argv 数组（没有 shell 转义问题）。先确认探针真的打印了，再谈结论。
4. 循环：改 → `probe_run` → 读 `[probe]` 行，同一轮里可以重复十几遍。探针一直留着，别中途拆。
5. 能回答 goal 了，`probe_clean`（不确定就先 `dryRun=true` 看计划）。
6. `probe_guard scope=staged`，绿了才继续。
7. `probe_report action=append` 记下「问题 → 结论」，然后收工。

细节看 `probe_guide section=pitfalls`（会真的踩到的坑）与 `section=languages`（各语言注释符与注意点）。
