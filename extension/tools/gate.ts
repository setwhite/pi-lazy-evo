/**
 * 门控判定（确定性小工具）：单实体四态推导——最新验证记录时间 vs 实体 mtime。
 * 纯函数无 IO；类型来自 store（type-only，运行时零耦合）。
 * 批量门控与清单筛选等整体逻辑在 core/gate.ts，不进 tools。
 */
import type { EntityMeta, VerificationRecord } from "../core/store.ts";

/** 门控四态 */
export type GateState = "passed" | "failed" | "none" | "stale";

/** 门控四态全集（counts 初始化等遍历用） */
export const GATE_STATES: readonly GateState[] = ["passed", "failed", "none", "stale"];

/** 容差窗口（毫秒）：验证时间与正文修改时间在此窗口内视为"新鲜"。
 * 抵消粗粒度文件系统（容器挂载/SMB/FAT32）的时间戳取整，以及"写实体→追加记录"同时刻竞争导致的顺序反转。
 * 偏大无实际代价：正文修改是低频手动操作，改动后几秒内被采信的概率趋近于零。 */
export const GRACE_MS = 3_000;

/** 门控徽标文本（注入提示词：query 索引行 / verify 清单） */
export const GATE_LABEL: Record<GateState, string> = {
	passed: "✅ 已验证",
	failed: "⚠️ 验证失败",
	none: "❓ 未验证",
	stale: "⏳ 已过期（需复验）",
};

/** 门控结果 */
export interface GateResult {
	/** 四态之一 */
	state: GateState;
	/** 最新验证记录（无记录时为 null） */
	latest: VerificationRecord | null;
	/** 实体文件修改时间（毫秒） */
	entityMtimeMs: number;
}

/**
 * 计算实体的门控状态：
 * - 无验证记录 → none（未证实）
 * - 最新记录早于实体最近修改 → stale（待复验）：正文改过，旧验证不再匹配
 * - 否则按最新记录结果 passed/failed
 */
export function computeGate(meta: EntityMeta, verifications: VerificationRecord[]): GateResult {
	const latest = verifications.length
		? verifications.reduce((a, b) => (b.checkedAtMs > a.checkedAtMs ? b : a))
		: null;
	if (!latest) return { state: "none", latest, entityMtimeMs: meta.mtimeMs };
	const state: GateState = latest.checkedAtMs < meta.mtimeMs - GRACE_MS ? "stale" : latest.result;
	return { state, latest, entityMtimeMs: meta.mtimeMs };
}
