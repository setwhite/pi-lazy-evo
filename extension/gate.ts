/**
 * 门控域：实体信任状态推导（纯计算，不 IO）。
 * 状态永远由"实体正文 mtime vs 最新验证记录时间"实时推出，不落盘、每次现算。
 */
import type { EntityMeta, EntityWithVerifications, VerificationRecord } from "./store.ts";

/** 门控四态 */
export type GateState = "passed" | "failed" | "none" | "stale";

/** 门控四态全集（counts 初始化等遍历用） */
export const GATE_STATES: readonly GateState[] = ["passed", "failed", "none", "stale"];

/** 容差窗口（毫秒）：验证时刻与正文修改在此窗口内视为"新鲜"。
 * 抵消粗粒度文件系统（容器挂载/SMB/FAT32）时间戳取整与"写实体→追加记录"同时刻竞争。
 * 偏大无实际代价：正文修改是低频手动操作。 */
export const GRACE_MS = 3_000;

/** 门控徽标（注入提示词：query 索引行 / verify 清单） */
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

/** 单实体四态推导：
 * 无记录 → none；最新记录早于正文修改（超容差）→ stale；否则按最新记录结果 passed/failed。 */
export function computeGate(meta: EntityMeta, verifications: VerificationRecord[]): GateResult {
	const latest = verifications.length
		? verifications.reduce((a, b) => (b.checkedAtMs > a.checkedAtMs ? b : a))
		: null;
	if (!latest) return { state: "none", latest, entityMtimeMs: meta.mtimeMs };
	const state: GateState = latest.checkedAtMs < meta.mtimeMs - GRACE_MS ? "stale" : latest.result;
	return { state, latest, entityMtimeMs: meta.mtimeMs };
}

/** 需要（重新）验证的门控状态：未证实 + 过期 */
export const NEEDS_VERIFICATION: ReadonlySet<GateState> = new Set(["none", "stale"]);

/** 实体与门控结果配对（gateLibrary 返回项） */
export interface GatedEntity {
	meta: EntityWithVerifications["meta"];
	gate: GateResult;
}

/** 批量门控：整库配对 → 门控结果 */
export function gateLibrary(items: EntityWithVerifications[]): GatedEntity[] {
	return items.map(({ meta, verifications }) => ({ meta, gate: computeGate(meta, verifications) }));
}

/** 待验实体选取：指定 id 时全量复验该实体（含 passed/failed）；未指定只挑 none/stale，保持原顺序 */
export function selectPending(gated: GatedEntity[], targetId?: string): GatedEntity[] {
	if (!targetId) return gated.filter((g) => NEEDS_VERIFICATION.has(g.gate.state));
	return gated.filter((g) => g.meta.id === targetId);
}

/** 待验清单注入项（手动命令与 auto 挡共用） */
export interface PendingEntity {
	id: string;
	kind: string;
	state: GateState;
}

/** 门控实体 → 注入清单项 */
export function toPending(gated: GatedEntity[]): PendingEntity[] {
	return gated.map(({ meta, gate }) => ({ id: meta.id, kind: meta.kind, state: gate.state }));
}

/** 全库摘要：四态计数 + 待验清单（overview 展示用） */
export interface LibrarySummary {
	counts: Record<GateState, number>;
	pending: { id: string; state: GateState }[];
}

/** 全库统计摘要：四态计数与待验清单一次算齐 */
export function summarizeLibrary(gated: GatedEntity[]): LibrarySummary {
	const counts = Object.fromEntries(GATE_STATES.map((s) => [s, 0])) as Record<GateState, number>;
	const pending: { id: string; state: GateState }[] = [];
	for (const { meta, gate } of gated) {
		counts[gate.state]++;
		if (NEEDS_VERIFICATION.has(gate.state)) pending.push({ id: meta.id, state: gate.state });
	}
	return { counts, pending };
}