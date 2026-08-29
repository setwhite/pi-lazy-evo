# 架构设计

## 定位

`.memory/` 实体记忆库的治理协议 + pi 扩展：

- **协议**（`extension/protocol/`）：实体与验证记录的格式、record/verify 操作手册，
  是代理操作记忆库的唯一真相源；
- **扩展**（TypeScript）：`/memory` 命令入口、门控计算、挡位与 auto worker；
- **零工具注入**：扩展不注册专用工具，代理用通用工具（grep/read/write/bash）按手册
  操作 `.memory/`。工具集不被污染、prompt cache 不受影响、协议迭代无需扩展发版。

## 目录结构

```
pi-lazy-evo/
├── extension/       # 扩展实现
│   ├── index.ts         # 装配入口：Runtime（协议路径 + dispatch + 会话 cwd）+ 注册命令 + auto 钩子
│   ├── commands.ts      # 单一 /memory 入口：子命令表（路由/帮助/补全单一数据源）+ 6 个子命令
│   ├── auto.ts          # auto 挡：turn_end 水位判定 + record/verify 派发 + 无管道 spawn
│   ├── library.ts       # 库快照与 diff（auto 挡结果通知的数据基础）
│   ├── prompts.ts       # 代理任务纯数据（AgentTask）+ 提示词组装注入（主会话/worker 共用）
│   ├── store.ts         # 存储域：布局 / 实体 / 验证记录（子目录）/ 全库配对
│   ├── gate.ts          # 门控域：四态推导 / 依赖失效覆盖 / 待验筛选 / 全库摘要（纯计算，无 IO）
│   ├── deps.ts          # 统一读库入口 gatedLibrary：读库 → 门控 → depends-on 失效叠加
│   ├── config.ts        # settings 命名空间读写（pi-lazy-evo）
│   ├── utils.ts         # 纯工具：frontmatter / 校验 / 文本提取 / 通知
│   └── protocol/        # 协议手册（代理执行契约）
├── tests/               # bun:test 单元测试（按域拆分）
├── docs/                # 用户指南 / 架构设计 / 开发指南（随 npm 包分发）
└── .github/workflows/   # npm 发布（OIDC trusted publishing）
```

依赖方向 `index → {commands, auto} → {prompts, gate, store, deps} → utils`；utils 最底层
（纯工具，无 IO 无业务），store 不依赖上层；gate 纯推导，mtime 能力由 deps 注入。

模块边界：

- `commands.ts` 只做"解析输入 → 调 gate/prompts → 通知"，业务聚合在 gate；
- `prompts.ts` 是任务纯数据（要代理干什么）+ 组装注入，
  手动命令（主会话）与 auto worker（子进程）共用同一套任务语义；
- `auto.ts` 只做触发编排（水位判定 → 串行双任务）与子进程通道，任务语义来自 prompts；
- `store.ts` 一个文件承载存储域（布局 / 实体 / 验证记录 / 全库配对），读取层"尽力解析 + 非法忽略"；
- 一切读库入口统一走 `deps.ts` 的 `gatedLibrary(cwd)`，调用方不自行拼装 readLibrary/gateLibrary。

## 数据模型

```
.memory/
├── entities/          # 实体：一个文件一张
└── verifications/     # 验证记录：verifications/<id>/<日期>[-N].md，按实体归位，只追加
```

**实体**（`entities/<id>.md`）：front-matter 为 id / kind / sources 三必填字段 + 可选
depends-on（仓库内相对路径，逗号分隔）；正文每句一个可验证断言，新增/修正的实体带编号
（`A1:`、`A2:`…，编号不复用，修正落点按编号定位）。文件名即 id，信任不放在正文里。

**验证记录**（`verifications/<id>/<日期>[-N].md`，日期只防重名，门控不读文件名）：
front-matter 恰好 target / validator / checked_at / result 四字段，证据写在正文（必填）；
failed 记录正文首行是无效断言编号清单，驱动"修正→stale→复验"闭环。

字段取值与校验规则以 `extension/protocol/entities.md` / `verifications.md` 为准，
代码不重复这些规则，只做"尽力解析 + 非法忽略"的严格读取。

**门控四态**：取实体最新验证记录（checked_at 最大），对比正文 mtime 与 depends-on 文件 mtime：

| 条件 | 状态 |
|---|---|
| 无任何记录 | ❓ none |
| 最新记录 passed 且晚于正文修改 | ✅ passed |
| 最新记录 failed 且晚于正文修改 | ⚠️ failed |
| 最新记录早于正文修改（超容差） | ⏳ stale |
| passed，但任一 depends-on 文件在该次验证后改过 | ⏳ stale |

3 秒容差（`GRACE_MS`）抵消粗粒度文件系统（容器挂载 / SMB / FAT32）的时间戳取整。
门控不落盘、每次实时推导（含依赖失效：比较锚点是最新 passed 记录时刻，复验即自愈，
无基线缓存文件）；格式非法的实体与记录一律忽略（front-matter 损坏、id/kind
缺失、target 不精确匹配、checked_at 非完整 ISO、result 非法；字段值的包裹引号会剥离）。

## 命令流

`/memory` 按参数第一词路由（pi 只匹配 `/` 后第一个词，多词命令名不可达）。
补全两级：子命令词 + 参数候选（mode 静态列表，verify 动态读库列实体 id）。
pi 传的补全 prefix 是 `/memory` 后完整参数串、选中值整体替换，因此参数候选的
value 必须带子命令词（如 `mode auto`）。

- `overview`：读库 → 门控 → 四态计数 + 待修正/待验清单（failed 优先展示），只展示不注入
- `record [note]`：注入记录任务（note 作为附注素材），代理自行完成读协议 → 检索 → 写入
- `query [terms]`：扩展算好全库索引（门控态预计算）注入，grep 与相关性判断靠代理自带工具
- `verify [id]`：读库 → 门控 → `selectPending`（无 id 选 none/stale 验证 + failed 修正，有 id 全量复验）→ 注入清单；failed 实体先按最新记录的无效断言编号修正正文再复验，禁止对未修正正文重复验证
- `mode [auto|manual]`：读写全局 settings.json 的 `pi-lazy-evo` 命名空间（mode 只存全局、不随仓库分发），不改任何模型可见面

手动命令与 auto 挡共用注入链路：`selectPending → verifyTask / recordTask → injectTask`。
职责边界：`/memory verify` 只把清单算好注入，验证动作本身交给代理执行。

## auto 挡

挂在 `turn_end` 事件上：水位判定（纯函数）→ record（串行单任务）→ verify（并行批次）。

**水位判定**（`decideAutoTrigger`）：会话累计 token 与基线之差达到 `autoWatermarkTokens`
触发一次。三个防循环规则：

- 首次观察只吸收基线，不触发
- token 回落（compaction）重设基线，不触发
- worker 在跑（inFlight）时吸收增量，结束后不重复触发

**worker 子进程（无管道通道）**：任务提示词写入临时文件，spawn 独立 `pi -p --no-session`
子进程，`--tools` 传白名单、`--model` 传便宜模型（缺省主模型）、`--thinking low`。
`spawn` 用 `non-detached + unref + stdio 全 ignore`：继承父控制台不弹窗（detached 在
Windows 必弹新控制台）；超时兜底与结果判定依赖主进程存活——主进程退出后 worker 不随之终止
（POSIX 变孤儿继续跑，Windows 视关闭方式可能连带终止）。轮数上限 `autoMaxTurns` 只是提示词
软约束；主进程存活期另有 10 分钟超时强杀进程树兑底（`killWorkerTree`）；worker 成败由调用方用库快照 diff 判定，不读子进程输出。

**verify 并行批次**：待办实体（含 failed 修正流）按 `splitPending` 切块（块数 ≤ 并发上限 8），每块一个子进程
并发跑；批次前后统一快照 diff，汇总一条通知（`Worker×N` + 结果/失败明细）。

**结果通知**：worker 前后各拍一次库快照（实体 id→mtime + 验证记录文件名→target/result），
diff 后一行通知：record 报 `+ 新增 / ~ 更新`，verify 报 `+ 验证：<id> ✅/⚠️`。

**会话边界冲刷（session_shutdown）**：水位窗口之外的会话尾部增量在会话离开时补固化。
`new` / `resume`（会话切换，主进程存活）：节流（`autoFlushMinTokens`，距上次固化增量不足
跳过）通过则 spawn record worker 立即固化——只 record 不 verify（verify 只在水位触发跑），
无通知；`quit` / `reload` / `fork`：不依赖子进程可靠性，尾部全量 transcript 落盘
`.memory/pending.md`（纯 IO 覆盖写），下次任一 record（水位触发或冲刷）合并素材并消费
（record 成功后删除）。

## 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 工具集不污染、prompt cache 不受影响、协议迭代无需发版 |
| grep 检索而非向量索引 | 库小、零依赖、无预计算 |
| 验证只追加不覆盖 | 可审计 |
| 门控实时计算 | 状态永远由实体 + 验证记录两个唯一真相推出 |
| 依赖失效纯推导，否决 state.json | 早期"门控缓存落盘"实现后被发现：缓存字段只写不读、门控仍需全量重算；改以"最新 passed 记录时刻 vs 依赖 mtime"推导，自愈且少一个状态文件 |
| 断言编号不回填存量 | 存量实体批量加编号是纯迁移债；修正/新增时自然生效，failed 记录首行无效编号清单驱动修正 |
| 任务语义两条通道共用 | 手动与 auto 同一套 AgentTask，改动只在一处 |
| query 门控预计算注入 | 死板计算留在扩展代码，代理只做语义判断 |
| 模式切换只写全局 settings.json | mode 是用户偏好：不入库、不随仓库分发、不被 git 覆盖；工具集/提示词不变，切换不影响 prompt cache |

## pi 行为事实（SDK 源码验证）

- 命令派发只匹配 `/` 后第一个词 → 单一 memory 入口 + args 路由；
- Tab 不触发命令补全，候选自动弹出；补全 prefix 是 `/memory` 后完整参数串，
  选中值整体替换该串（参数候选 value 须带子命令词，如 `mode auto`）；
- 扩展发现：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目，信任后加载），
  支持符号链接。