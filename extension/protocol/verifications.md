# 记忆库协议 — 验证记录

验证记录位于 `.memory/verifications/`，追加任何记录前请把本手册与操作手册一起读完。实体文件格式见 entities.md。

## 验证记录格式

`verifications/<日期>-<id>.md`，只追加——绝不修改旧文件。
同一实体同日多条时，文件名自动加序号后缀：`<日期>-<id>-2.md`、`-3.md`…

| 字段 | 取值 |
|---|---|
| target | entities/<id>.md |
| validator | 见下方验证器 |
| checked_at | 当前真实时间的 ISO 时间戳（见时间戳纪律） |
| result | passed / failed |

front-matter 恰好这四个字段。记录正文（front-matter 之外的全部内容）是证据——
自由文本，承载可复核依据（来源、命令输出、用户的原话）。证据必填：没有正文的记录不算验证。

**时间戳纪律（硬约束）**：checked_at 是门控（stale 判定）的唯一时间依据，必须写
执行验证那一刻的**真实当前时间**——追加记录前先运行 `date` 命令取系统时间，原样填入
（保留时区）。禁止推断、回溯、占位或任何形式的编造：错误时间戳会把实体永远钉在
stale（重复验证、记录堆积），或让过期验证冒充新鲜异象，两种情况都污染门控。

不合规的记录（target 不是 entities/<id>.md、result 非法、checked_at 非 ISO）会被扩展忽略。

## 验证器（v2：分层抽象为一组验证器）

| 验证器 id | 判断权威 | 说明 |
|---|---|---|
| format | 代理 | front-matter 与文件名结构核对 |
| conflict | 代理 | 通读记忆库，判断重叠/矛盾，把分析写进记录正文 |
| code | 代理 | 自己编写并运行命令（如 bash）；把 `code: <命令>` 与输出写进记录正文 |
| web | 代理 | 联网调研，把发现写进记录正文 |
| user | 用户 | 询问用户，把确认写进记录正文 |

`validator` 字段取值：`format` / `conflict` / `code: <命令>` / `web-research` / `local-evidence` / `user-confirm`（后三个与 v1 历史兼容）。
自定义验证器字段已预留（mode: custom + command）；无需改协议与存储。

## 门控：四态

取实体最新的验证记录（checked_at 最大者），与其正文文件 mtime 对比：

| 条件 | 状态 | 处置 |
|---|---|---|
| 最新记录 passed 且晚于正文最后修改 | ✅ passed | 当事实用 |
| 最新记录 failed 且晚于正文最后修改 | ⚠️ failed | 不得当事实用；可复验 |
| 完全没有记录 | ❓ unverified | 慎用；关键决策依赖前先验证 |
| 最新记录早于正文最后修改 | ⏳ stale（需复验） | 正文改过，旧验证不再匹配；复验或忽略 |

更新实体正文无需删除记录——时间戳规则自动把它降为"stale（需复验）"。
