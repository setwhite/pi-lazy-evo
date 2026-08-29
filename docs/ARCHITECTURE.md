# 架构设计

## 定位

`.memory/` 实体记忆库的治理协议 + pi 扩展：

- **协议**（`extension/protocol/`）：实体与验证记录的格式、record/verify 操作手册，代理操作记忆库的唯一真相源；
- **扩展**（TypeScript）：`/memory` 命令入口、门控计算、挡位与 auto worker；
- **零工具注入**：扩展不注册专用工具，代理用通用工具（grep/read/write/bash）按手册操作 `.memory/`。
  工具集不被污染、prompt cache 不受影响、协议迭代无需扩展发版。

## 结构与依赖

```
extension/
├── index.ts       # 装配入口：Runtime（协议路径 + dispatch + 会话 cwd）+ 注册命令与 auto 钩子
├── commands.ts    # /memory 单一入口：子命令表（路由/帮助/补全单一数据源）
├── auto.ts        # auto 挡：水位判定 / 启动冲刷 / 尾部落盘 + 任务编排
├── worker.ts      # worker 子进程通道：--mode json 事件流 → 活动面板（前台可见）
├── library.ts     # 库快照与 diff（auto 挡结果通知的数据基础）
├── prompts.ts     # AgentTask 纯数据 + 提示词组装（主会话/worker 共用）
├── store.ts       # 存储域：布局 / 实体 / 验证记录（尽力解析 + 非法忽略）
├── gate.ts        # 门控域：四态推导 / 依赖失效 / 待验筛选（纯计算，无 IO）
├── deps.ts        # 统一读库入口 gatedLibrary(cwd)
├── config.ts      # settings.json pi-lazy-evo 命名空间读写
├── utils.ts       # 纯工具：frontmatter / 校验 / 文本提取 / 通知
└── protocol/      # 协议手册（代理执行契约）
```

依赖方向 `index → {commands, auto} → {worker, prompts, library, gate, store, deps} → utils`。
边界约定：一切读库走 `deps.gatedLibrary`；`commands` 只做"解析 → 调 gate/prompts → 通知"；
`auto` 只做触发编排与任务串行/并发，任务语义来自 `prompts`；`prompts` 是任务纯数据，
不复述手册内容（规则以 protocol/ 为唯一真相源）；`worker` 只管子进程通道与活动呈现。

## 数据模型

实体 `entities/<id>.md` 与验证记录 `verifications/<id>/<日期>[-N].md` 的字段、编号与时间戳规则
以 `protocol/entities.md`、`protocol/verifications.md` 为准，代码不重复这些规则，
读取层只做"尽力解析 + 非法忽略"的严格读取（包裹引号会剥离）。

**门控四态**（❓none / ✅passed / ⚠️failed / ⏳stale）每次由"最新记录 checked_at vs
正文 mtime vs depends-on 文件 mtime"实时推导，不落盘、无缓存文件；
3 秒容差（`GRACE_MS`）抵消粗粒度文件系统的时间戳取整。语义表见 protocol/verifications.md。

## 命令流

`/memory` 按参数第一词路由（pi 派发只匹配 `/` 后第一个词，多词命令名不可达）。
补全两级：子命令词 + 参数候选；pi 选中值整体替换参数串，因此参数候选 value 须带子命令词（如 `mode auto`）。

- `overview`：读库 → 门控 → 展示四态计数与待修正/待验清单（不注入）
- `record` / `query` / `verify`：`recordTask / queryTask / verifyTask → injectTask` 注入主会话，
  代理按协议执行；职责边界——扩展只把清单/索引算好注入，动作本身交给代理
- `mode`：读写全局 settings.json 的 `pi-lazy-evo` 命名空间（mode 只存全局，不改任何模型可见面）

手动命令与 auto 挡共用同一套 AgentTask 语义，仅通道不同：手动走主会话注入，auto 走 worker 子进程。

## auto 挡

turn_end 水位触发 + session_start 启动冲刷，两条通道同一套 runAutoTasks；
session_shutdown 只把会话尾部落盘 `.memory/pending.md`（纯 IO，不 spawn）。

**钩子只在宿主会话生效**（`autoHooksEnabled(ctx.mode)`，三个钩子入口早退）：worker 子进程同样加载本扩展
并走完 session 生命周期，且与宿主共用同一 `.memory/`——若不早退，session_start 见到 `pending.md` 会再
spawn 一个 worker（无界递归），session_shutdown 会把 worker 自己的转录写进 `pending.md`（覆盖宿主素材）。

**水位判定**（`decideAutoTrigger`，纯函数）：会话累计 token 增量达到 `autoWatermarkTokens` 触发一次。
三个防循环规则：首次观察只吸收基线；token 回落（compaction）重设基线；worker 在跑（inFlight）时吸收增量。

**worker 子进程（前台可见）**：提示词写临时文件，spawn `pi --mode json --no-session`，
`--tools` 白名单、`--model` 便宜模型（缺省主模型）、`--thinking low`。
stdout 事件流逐行解析（`turn_start` / `tool_execution_start`），每个 worker 在活动面板
（`ctx.ui.setWidget`，编辑器上方）占一行，全部结束后面板清除、汇总一条通知。
成败仍以库快照 diff 判定（事件流只做展示，退出码仅兜底报错）；主进程存活期 10 分钟超时强杀进程树；
主进程退出后管道断裂，worker 随会话终止（前台语义，不留孤儿）。

**verify 并行批次**：待办实体（含 failed 修正流）按 `splitPending` 切块（块数 ≤ 并发上限 8），
每块一个子进程并发跑；批次前后统一快照 diff，汇总一条通知（`verify×N`）。

**ctx 生命周期**：事件 ctx 在会话替换（new/resume/reload）后失效，不得跨 await 持有——
处理器内只取纯值（cwd/transcript），通知与活动面板走 stale 兜底闭包（guardNotify / guardActivity）。

## 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 工具集不污染、prompt cache 不受影响、协议迭代无需发版 |
| grep 检索而非向量索引 | 库小、零依赖、无预计算 |
| 验证只追加不覆盖 | 可审计 |
| 门控实时计算、否决 state.json | 状态永远由实体+验证记录两个真相推出；早期缓存落盘实现被发现字段只写不读 |
| 断言编号不回填存量 | 批量迁移是纯债；修正/新增自然生效，failed 记录首行编号清单驱动修正 |
| 任务语义两条通道共用 | 手动与 auto 同一套 AgentTask，改动只在一处 |
| 手册唯一真相源，提示词不复述 | 改手册即改行为，不用动代码；提示词短、省 token |
| 事件流只做活动展示 | 成败以文件系统快照判定，UI 通道与正确性解耦 |
| query 门控预计算注入 | 死板计算留在扩展代码，代理只做语义判断 |
| mode 只写全局 settings.json | 用户偏好：不入库、不随仓库分发；切换不改模型可见面，不影响 prompt cache |
