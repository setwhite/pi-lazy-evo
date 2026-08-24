# 架构设计

本文描述 lazy-memory 扩展的定位、分层、数据模型与设计决策，是代码的权威架构说明。

## 1. 定位

**.memory 实体记忆库的治理协议 + pi 扩展**：

- **协议**（`extension/protocol/`）：entities.md + verifications.md 两份领域格式
  （按 worker 职责拆分，各自只读需要的）+ record/query/verify 三份操作手册，是代理执行任务的契约；
- **扩展**（TypeScript）：命令扳机（`/memory` 族）、门控计算、挡位状态、自动挡 worker；
- **哲学**：零工具注入——扩展只做"扳机 / 门控 / 协议"，**读写与验证全部由代理按协议手册执行**。

> 为什么零工具注入：扩展不给模型注入任何专用工具（不注入 search/write 之类），
> 模型用通用工具（grep/read/write/bash）按 `protocol/` 手册操作 `.memory/`。
> 好处：不污染工具集、不影响 prompt cache、协议调整无需发版。

## 2. 目录结构

```
extension/
├── index.ts              # 装配入口：Runtime + 注册命令 + 挂 auto 钩子（保留根，pi 自动加载点）
├── core/                 # 核心逻辑层
│   ├── config.ts         #   配置：settings.json 的 lazy-memory 命名空间（挡位 + auto 阈值/模型/轮数）
│   ├── store.ts          #   存储 barrel：透出全符号 + readLibrary 整库配对
│   ├── entities.ts       #   实体域：校验 / 读写 / 出处合并
│   ├── verifications.ts  #   验证域：追加 / 解析 / 过滤
│   ├── layout.ts         #   目录骨架：memoryDir / ensureMemoryDir
│   └── gate.ts           #   门控纯计算：四态 + 聚合摘要（summarize/selectPending）
├── agents/settler/       # 执行层：命令动作 = 拼提示词 → dispatch
├── commands/             # 5 个 /memory 命令扳机
├── tools/                # 通用工具（无状态）：notify、frontmatter 解析
├── tests/                # bun:test 单元测试（按域拆分）
├── hooks/
│   ├── auto.ts           # 自动挡入口：turn_end 水位判定 + 串行编排
│   ├── worker.ts         # worker 公共设施：提示词文件/spawn/单 worker 执行
│   ├── memo-worker.ts    # 沉淀 worker：素材抽取 + 提示词
│   └── verify-worker.ts  # 验证 worker：提示词
└── protocol/             # 协议手册（代理执行契约）
```

## 3. 分层约定

| 层 | 职责 | 说明 |
|---|---|---|
| index | 装配 + 共享状态 | 入口内联 Runtime（协议路径 + dispatch 注入），薄壳不分文件 |
| config | 配置 | settings.json 的 lazy-memory 命名空间读写（挡位 + auto 阈值/模型/轮数） |
| store | 存储 IO | `.memory/` 读写；barrel 在 store.ts，子域在 entities/verifications/layout |
| gate | 纯计算 | 四态门控 + 批量门控 + 聚合摘要，**不 IO** |
| agents/settler | 执行层 | 动作 = 拼提示词 → dispatch；命令专用 |
| commands | 扳机 + 展示 | 只算输入与 TUI 通知，不跑协议逻辑 |
| tools | 通用工具 | 无状态：TUI 通知、front-matter 解析 |
| tests | 单元测试 | bun:test 按域拆分，`bun test` 一键跑 |
| hooks | 自动挡 | turn_end 水位判定 + 串行双 worker spawn，不参与命令流程 |
| protocol | 协议文档 | 代理执行契约，扩展不执行其语义 |

**依赖方向**：`index → commands → agents/settler → core`；`tools` 与 `protocol` 被多方引用；
`gate` 依赖 `store` 的**类型**（type-only import），不反向 IO。

## 4. 数据模型（.memory/）

```
.memory/
├── entities/          # 实体：一个文件一个
└── verifications/     # 验证流水账：一次一条，只追加
```

### 实体文件（entities/<id>.md）

id 为小写连字符文件名，front-matter 恰好三字段：

| 字段 | 取值 | 说明 |
|---|---|---|
| id | 与文件名一致 | 唯一标识 |
| kind | tool / person / project / concept / decision | 类型 |
| sources | URL / 本地路径 / 会话引用 | 出处 |

正文规则：每句一个独立可验证断言、具体词（grep 可命中）、无代词、无推测；
不确定内容进 sources 不进正文。正文不承载信任状态——信任由最新验证记录推导。

### 验证记录（verifications/<日期>-<id>.md）

文件名日期仅作防重名标签（同日多条自动 `-2`/`-3`），**门控不读文件名日期**。
front-matter 五字段：

| 字段 | 取值 |
|---|---|
| target | entities/<id>.md |
| validator | format / conflict / code: <命令> / web-research / local-evidence / user-confirm |
| checked_at | ISO 时间戳 |
| result | passed / failed |
| evidence | 可复核依据 |

### 门控四态

取最新验证记录（max `checked_at`）对比实体文件 mtime：

| 条件 | 状态 | 处置 |
|---|---|---|
| 最新记录 passed 且晚于正文修改 | ✅ passed | 当事实用 |
| 最新记录 failed 且晚于正文修改 | ⚠️ failed | 不用，可复验 |
| 无任何记录 | ❓ unverified | 慎用，关键依据先补验 |
| 最新记录早于正文修改 | ⏳ stale | 正文改了，旧验证失效，先复验 |

**核心妙处**：更新实体正文无需删验证记录——时间戳规则自动把实体降为 stale。

实现细节：`computeGate` 为"最新记录时间 ≥ 正文 mtime − 3s 容差"判定 stale，
3s 容差（`GRACE_MS`）抵消粗粒度文件系统时间取整与"写实体→追加记录"同时刻顺序反转。

### 严格性（v1 兼容层已移除）

扩展只承认符合上述格式的数据，损坏文件/记录一律忽略：
- target 精确等于 `entities/<id>.md`（不接受 `.memory/` 前缀）；
- checked_at 必须是完整 ISO（含时刻），纯日期记录无法定时刻即丢弃；
- 无合法 front-matter（缺 id/kind）的实体文件不入库。

## 5. 装配与注入

- `index.ts` 的 `Runtime` 持有 `protocolDir` 与 `dispatch`（`pi.sendUserMessage`），
  通过依赖注入传给命令与 agent，无模块级全局变量；
- `protocolDir` 默认取源码同目录的 `protocol/`，提示词层不感知部署位置；
  移动时改 `index.ts` 一处即可；
- `registerAutoModeHooks` 在入口挂载 turn_end 钩子，触发判定为纯函数（可单测），
  真实 spawn 为薄壳；worker 子进程是 `pi --mode json -p --no-session`，自带通用工具。

## 6. 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 不污染工具集、协议可迭代，代理按手册执行 |
| grep 检索而非向量索引 | 库小、无预计算、零依赖，检索成本可忽略 |
| 验证只追加不覆盖 | 可审计；改错事实走"追加 failed 记录"而非篡改正文 |
| 正文不带信任状态 | 门控由时间戳动态推导，正文改动自动降级 stale |
| 门控不落盘 | 每次实时计算，状态永远反映"实体+验证记录"这两个唯一真相 |
| 命令层薄、门控纯、store 域拆 | 分层清晰、可单测；gate 纯函数不 IO 便于构造用例 |
| 运行时注入协议路径 | 安装位与仓库分离（软链）后协议依然可达 |

## 7. 扩展点

- **auto 自动模式**（已实现）：`hooks/auto.ts` 挂 turn_end 时钟，`getContextUsage` 取累计
  token，增量达 `autoWatermarkTokens`（默认 64k）时，串行 spawn 两个独立 pi 子进程：
  - **沉淀 worker**：喂最近会话素材，按 `record.md` 提炼实体；
  - **验证 worker**：不带素材，按 `verify.md` 核对 unverified/stale 实体；
  - 模型用 `autoModel`（便宜模型，缺省回退主会话模型），轮数上限 `autoMaxTurns` 写进提示词；
  - 两 worker 的工具白名单可配（`autoMemoTools` / `autoVerifyTools`，默认验证集含
    `web_search,web_fetch` 供 web-research 验证器联网核对），配置覆盖即替换默认集；
  - 防循环：首次吸收基线、compaction 回落重设基线、worker 在跑时吸收增量不重复触发。
- **custom verifier**（协议预留）：`mode: custom + command`，无需改协议与存储。

## 8. 发布待办（自 v1→v2 迁移遗留）

- [ ] 机外副本清理：删除历史 `~/.pi/skills/lazy-memory/` 等 v1 安装副本
- [ ] 安装位软链：`~/.pi/extensions/lazy-memory` → `<仓库>/extension`
- [ ] 端到端回归：`pi -e` 验证命令可用、确认零工具注入
- [ ] 发布：push GitHub
