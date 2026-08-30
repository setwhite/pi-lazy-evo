# 记忆库协议 — 验证

由 `/memory verify all`（全库待办：unverified / stale 验证 + failed 修正）、
`/memory verify <id>`（全量复验该实体）或 auto 任务触发。追加任何记录前，先读本手册、entities.md 与 verifications.md。

## 纪律

- 扩展不提供验证器执行，也不注入工具：一切核对由代理（与用户）完成。
- 每条记录必须带证据（写在记录正文，见 verifications.md）。实际核对过才追加 passed，否则追加 failed 并写明原因。
- 每次验证追加一条新记录到 `verifications/<实体id>/`，绝不碰已有记录（含其他实体的目录）。
- 开验前用 grep 通读库根的 entities/，找同事实互相矛盾的断言（同一代码行为、同一外部事实的相反说法），
  发现的矛盾写进相关记录的证据。

## 流程

1. failed 实体（待修正）：读其最新 failed 记录的无效断言编号与推翻依据 → 按 record 修正流程校正正文 →
   照常验证追加记录，收敛到 passed。禁止对未修正的正文重复验证。
2. unverified / stale 实体：逐条核对断言，有把握才追加 passed；stale 实体先读其全部旧记录再下判断
   ——旧验证记录是复核的起点，失败记录尤其要读。
3. 事实已无价值：正文保持不动，追加 failed 记录说明废弃理由。实体留在库中（failed 进修正流，
   若正文与最新 failed 记录均未变，`verify all` 会重复同一结论；需彻底停止重验可删除实体文件）。
