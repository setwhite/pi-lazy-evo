# 用户指南

lazy-memory 通过 5 个 `/memory` 命令和一套协议手册工作。命令负责"扳机"，
真正的读写/检索/验证由代理按 `extension/protocol/` 手册完成。

## 记忆库在哪

`.memory/` 在当前工作目录（可用 `MEMORY_DIR` 环境变量覆盖）。两个子目录：

```
.memory/
├── entities/          # 实体卡片：一个文件一张
└── verifications/     # 验证流水账：只追加不覆盖
```

## 命令一览

### /memory —— 总览

查看挡位、四态分布、待验清单，不注入代理。

```
/memory
→ Memory Overview
  Mode: manual
  Entities 3 | passed 1 / failed 0 / unverified 1 / stale 1
  Needs verification (2): foo (unverified), bar (stale)
  Run /memory verify for a batch check.
```

### /memory record —— 沉淀

提醒代理把会话里的**长期结论**沉淀进 `.memory/`（新建/更新实体）。
代理会先读 `record.md` 手册，自己 grep 已有实体判新增/更新，再写。

```
/memory record
→ Memory Record
  Reminder injected — the agent will settle memory now.
```

### /memory query [terms] —— 检索

提醒代理检索 `.memory/`，可带关键词（不带则由代理从会话推断意图）。
代理按 `query.md` 手册做语义 grep（原词+同义词+上下位词，中英都收），
报告每个命中的：实体 id、kind、门控状态、相关断言。

```
/memory query pi
→ Memory Query
  Reminder injected — the agent will search memory now.
```

### /memory verify [id] —— 验证

算出待验实体清单（unverified / stale）注入代理逐条核对。
不指定 id：只挑待验实体；指定 id：复验该实体（含已 passed/failed）。
代理按 `verify.md` 手册自行检查、追加验证记录（evidence 必填）。

```
/memory verify
→ Memory Verify
  Reminder injected for 2 entities — the agent will verify now.
```

### /memory mode [auto|manual] —— 挡位

查看或切换运行模式（写入 settings.json）。当前 auto 未实现，仅记录状态。

```
/memory mode
→ Memory Mode
  Current mode: manual
  Usage: /memory mode [auto|manual]
```

## 门控状态解读

每张实体卡片按"最新验证时间 vs 正文修改时间"得到四态：

| 状态 | 含义 | 怎么对待 |
|---|---|---|
| ✅ passed | 核对通过且没改过正文 | 当事实用 |
| ⚠️ failed | 核对失败 | 别用；可再验证 |
| ❓ unverified | 从没核过 | 慎用；关键依据先补验 |
| ⏳ stale | 正文改了，旧核对过期 | 先复验再信 |

代理检索命中实体时，会带上它的门控状态，你自己也能按 `status` 判断可信度。

## 底层协议手册

代理执行任务时读 `extension/protocol/` 下的英文手册（扩展不注入任何工具）：

- `schema.md`：共享规则（目录/字段/验证记录/门控/严格性）——一切格式的唯一真相源
- `record.md`：沉淀流程（写入/更新/与验证库的边界/提交约定 `memory:` scope）
- `query.md`：检索流程（语义 grep、多轮补漏、报告格式）
- `verify.md`：验证流程（evidence 必填、只追加、修正失效事实）

## 提交约定

`.memory/` 在 git 仓库内，变更天然可回滚可追溯。
涉及 `.memory/` 的提交用 Conventional Commits + `memory:` scope（documentation type）。

## 安装

当前为待发布状态。目标形态：`~/.pi/extensions/lazy-memory` 软链到本仓库 `extension/` 目录，
装机后 pi 自动加载。发布待办见 `ARCHITECTURE.md`。
