# 记忆库协议 — 验证

由 `/memory verify [id]` 触发：不接 id 时处理全部待办实体（unverified / stale 验证 + failed 修正），接 id 时全量复验该实体。
追加任何记录前，请先读本手册、entities.md 与 verifications.md。

## 执行纪律

- 扩展不提供验证器执行，也不注入任何工具：一切判断由代理（与用户）完成。
- 每条记录都必须带证据——证据写在记录正文（见 verifications.md）。实际核对过才追加 passed，否则追加 failed 并在正文写明原因。
- 每次验证一个实体都是追加一条新记录到 `verifications/<id>/`——绝不碰已有记录（含其他实体的目录）。
- 记录格式、验证器语义与时间戳规则见 verifications.md；实体文件格式见 entities.md。

## 开验前：conflict 检查

用 grep 通读 .memory/entities 全部实体，找出同事实互相矛盾的断言（同一代码行为、同一外部事实的相反说法）。
发现的矛盾写进相关验证记录的证据（validator 用 conflict 或在其后追加核验）。

## 两类任务

**待修正（failed 实体）——先修正文再复验**：

1. 读该实体最新一条 failed 记录的正文：记录第一行是无效断言编号清单，正文含推翻依据。
2. 按编号校正实体正文（走 record 更新流程，只改被推翻的断言，接受 stale 降级）。
3. 随后照常验证并追加记录，收敛到 passed 或 failed（仍 failed 则继续修正——禁止对未修正正文重复验证）。
4. 若事实已无价值：追加一条 failed 记录说明废弃理由；实体保留在库中（门控 failed 不归入待验）。

**待验证（unverified / stale 实体）**：按 verifications.md 逐条核对断言，有把握才追加 passed。
对 stale 实体先读它的全部旧记录（含失败记录）再下判断——旧验证记录是复核的起点。

## 修正失效事实

1. 修正 = 更新实体正文（record 流程），不是写新实体；编号定位、只改被推翻的断言。
2. 验证记录只追加：修正之后旧记录仍在，门控自动降级为 stale（复验通过前不可当事实用）。
3. 若事实本身已无价值：保持正文不动，追加 failed 记录并说明，`verify` 不会再找回它。

## Git

`.memory/` 是个人运行时数据，不随仓库分发（gitignore）。绝不提交验证记录变更。