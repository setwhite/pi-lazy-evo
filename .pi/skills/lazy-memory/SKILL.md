---
name: lazy-memory
description: 被动记忆工具：管理 .memory/ 实体记忆库——抽象实体与描述、语义grep检索、分层验证、门控。仅当用户明确要求记住/记录、查询/检索记忆、验证或检查记忆、修正记忆事实时使用；日常对话绝不主动记录、检索或验证。
---

# lazy-memory

```
.pi/skills/lazy-memory/
├── references/PROTOCOL.md   # 协议总纲：一切格式与规则的唯一真相源
└── scripts/
    ├── verify.sh            # 批量执行 code 验证器（L2）
    └── status.sh            # 查询实体最新验证状态（门控）

.memory/
├── entities/          # 实体：一个文件一个
└── verifications/     # 验证流水账：只追加、不覆盖
```

所有格式与规则见 references/PROTOCOL.md，本文件只给出触发时机与取用入口。

## 记录实体

触发：用户明确要求记住，或出现长期稳定的可验证事实且用户确认。

先 grep 已有描述判定新/改/冲突（冲突先问用户），再按 PROTOCOL【实体文件格式】写或更新 `entities/<id>.md`。

## 检索实体

触发：行动依赖记忆，或用户要求查询。

按 PROTOCOL【检索协议】做语义 grep：提炼检索词 → grep `entities/` 全文 → 多轮补漏 → 判读相关 → 门控标注。

## 验证实体

触发：用户要求验证或体检，门控发现未证实/疑失效实体时。

先跑 `scripts/verify.sh`，再按 PROTOCOL【验证分层】【验证记录格式】逐实体补验并追加记录。

## 修正失效事实

触发：用户纠正、新证据推翻。

按 PROTOCOL【修正失效事实】执行（不改正文、追加 failed 记录、有价值则另建实体）。

## 门控

触发：检索命中、行动依赖实体之前。

先跑 `scripts/status.sh <id>`（无脚本环境自行核对 verifications/），判定规则见 PROTOCOL【门控】。