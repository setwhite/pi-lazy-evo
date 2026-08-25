# 架构设计

## 定位

`.memory/` 实体记忆库的**治理协议 + pi 扩展**：

- **协议**（`extension/protocol/`）：实体/验证记录格式 + record/verify 操作手册，
  代理执行契约（query 无手册：门控索引预计算注入）；
- **扩展**（TypeScript）：`/memory` 命令扳机、门控计算、挡位与 auto worker；
- **零工具注入**：扩展不注入专用工具，代理用通用工具（grep/read/write/bash）按手册
  操作 `.memory/`——不污染工具集、不影响 prompt cache、协议迭代无需发版。

## 目录结构

```
extension/
├── index.ts         # 装配入口：Runtime（协议路径 + dispatch + 会话 cwd）+ 注册命令 + auto 钩子
├── core/            # config 配置 / store 存储（entities·verifications·layout 子域）/ gate 门控整体逻辑
├── prompts/         # tasks 任务纯数据 + build 提示词组装注入
├── commands/        # 单一 /memory 入口 + 子命令表（路由/帮助/补全单一数据源）
├── subagents/       # auto 挡：turn_end 水位判定 + 串行编排 + spawn worker 子进程
├── tools/           # 确定性小工具：validate / 单实体门控 / notify / frontmatter / 文本提取
├── tests/           # bun:test 单元测试（按域拆分）
└── protocol/        # 协议手册（代理执行契约）
```

依赖方向：`index → commands/subagents → prompts → {core, tools}`；
tools 最底层（对 store 仅 type-only）。

## 数据模型（.memory/）

```
.memory/
├── entities/          # 实体：一个文件一张
└── verifications/     # 验证流水账：一次一条，只追加
```

**实体**（`entities/<id>.md`，id 任意非空单行、不含换行/路径分隔符）：

| 字段 | 说明 |
|---|---|
| id | 与文件名一致 |
| kind | tool / person / project / concept / decision |
| sources | 出处 |

正文：每句一个可验证断言、具体词、无推测；信任不由正文承载。

**验证记录**（`verifications/<日期>-<id>.md`，日期仅防重名，门控不读）：

| 字段 | 说明 |
|---|---|
| target | entities/<id>.md |
| validator | format / conflict / code: … / web-research / local-evidence / user-confirm |
| checked_at | 完整 ISO 时间戳 |
| result | passed / failed |

证据写在记录正文（必填）。

**门控四态**（最新记录时间 vs 正文 mtime，3s 容差）：

| 条件 | 状态 |
|---|---|
| 最新记录 passed 且晚于正文 | ✅ passed |
| 最新记录 failed 且晚于正文 | ⚠️ failed |
| 无记录 | ❓ unverified |
| 最新记录早于正文 | ⏳ stale |

更新正文自动降级 stale，无需删验证记录。门控不落盘，每次实时计算。
严格模式：格式非法/损坏文件一律忽略（target 精确匹配、checked_at 完整 ISO、证据只取正文）。

## 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 不污染工具集、不影响 prompt cache、协议可迭代 |
| grep 检索而非向量索引 | 库小、零依赖、无预计算 |
| 验证只追加不覆盖 | 可审计 |
| 门控实时计算 | 状态永远反映实体+验证记录两个唯一真相 |
| 任务语义两条通道共用 | 手动命令与 auto worker 同一套 AgentTask，改动只在一处 |
| query 门控预计算注入 | 死板计算留扩展代码，代理只做语义判断 |

## pi 行为事实（SDK 源码验证）

- 命令派发只匹配 `/` 后第一个词 → 单一 memory 入口 + args 路由；
- Tab 不触发命令补全，候选自动弹出；补全 prefix 是 `/memory` 后完整参数串，
  选中值整体替换该串（参数候选 value 须带子命令词，如 `mode auto`）；
- 扩展发现：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目，信任后加载），
  支持符号链接。

## 发布状态

- [x] 清理 v1 机外副本（`.pi/skills/lazy-memory/`）
- [x] 推送到 GitHub（origin/main 已同步）
- [x] 项目更名为 pi-lazy-evo（settings 命名空间 / 提示词 / 安装位同步）
- [ ] 全局安装位软链（当前以项目位 `.pi/extensions/` 安装）