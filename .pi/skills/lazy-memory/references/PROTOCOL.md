# .memory/ 实体记忆库协议（PROTOCOL）

skill 与任何未来引擎的唯一契约：实体格式、检索、验证、门控均以本文为准。

## 总则

- 不建图、不互相引用，一律 grep 检索。
- 验证记录只追加、不覆盖（可审计）。
- 库被动：仅显式请求才记录、检索、验证。

## 目录结构

```
.memory/
├── entities/          # 实体：每实体一个 <id>.md
└── verifications/     # 验证：每次一条 <日期>-<id>.md
```

本协议文件随 skill 存放于 `references/`。

## 实体文件格式

`entities/<id>.md`，文件名即 id（小写连字符）。front-matter 恰好三个字段：

| 字段 | 取值 | 说明 |
|---|---|---|
| id | 与文件名一致 | 唯一标识 |
| kind | tool / person / project / concept / decision | 类型 |
| sources | URL / 本地路径 / 会话引用 | 出处 |

正文描述规则：

- 每句一个独立可验证断言，用具体词写成（grep 能命中），不用代词。
- 无"大概 / 可能 / 我觉得"；不确定内容进 sources，不进正文。
- 正文不承载信任状态，信任由最新验证记录推导（见【门控】）。

示例：

```markdown
---
id: pi
kind: tool
sources: 会话 2026-08-18 / ~/.bun/install/global
---

CLI 编码代理，支持 skills、扩展、自定义模板。
全局安装在 ~/.bun/install/global。配置目录在 ~/.pi。
```

## 验证记录格式

`verifications/<日期>-<id>.md`，只追加新文件，不改旧文件。

| 字段 | 取值 |
|---|---|
| target | entities/<id>.md |
| validator | 见下表 |
| checked_at | ISO 时间戳 |
| result | passed / failed |
| evidence | 可复核依据 |

validator 取值：

- `code: <命令>`：执行命令，退出码 0 = passed
- `web-research`：联网核对
- `local-evidence`：本地证据
- `user-confirm`：问用户

## 检索协议（语义 grep）

1. 提炼检索意图。
2. 生成检索词：原词 + 同义词 + 上位词 + 别名，中英文都收（例：记忆 → memory、记忆库、remember）。
3. 用当前可用的 grep 类工具（内置 grep / rg / grep）搜 entities/ 全文，大小写不敏感。
4. 命中过少 → 用命中里的词反推新词，多轮补漏直到命中稳定。
5. 读命中全文判相关，只带相关的进上下文。
6. 无相关命中 → "无记录"，不编造。

约束：回答引用实体时给出 id（可溯源）；无向量、无索引、无预计算。

## 验证分层

按升序执行，每档独立可跳过：

| 档 | 内容 | 方式 |
|---|---|---|
| L0 | 文件结构 | 本地检查 |
| L1 | 与其他实体矛盾/重复 | grep 比对 |
| L2 | 内容是否仍为真 | 执行 `code:` 命令 |
| L3 | 外部事实 | web-research / local-evidence |
| L4 | 拿不准 | user-confirm |

触发：L0/L1 记录后顺手跑；L2 工具类优先、L3 人物/概念类优先、L4 高风险；用户要求体检时逐实体跑全档。

## 门控

取该实体最新验证记录（checked_at 最大者）：

| 最新记录 | 处置 |
|---|---|
| passed | 当事实用 |
| failed | 标"已失效"，不当事实用，可补验证 |
| 无记录 | 标"未证实"，慎用，关键依据出自它先补验证 |

## 修正失效事实

1. 不改实体正文（可审计）。
2. 追加 failed 记录，evidence 写推翻依据（来源、命令输出、用户原话）。
3. 事实仍有价值则另建实体；门控自动排除旧实体。