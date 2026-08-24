/**
 * 门控：由最新验证记录 + 时间戳规则推导实体的信任状态（四态）。
 * 状态不落盘，每次查询实时计算——正文与验证记录是唯一真相源。
 */
import type { EntityMeta, EntityWithVerifications, VerificationRecord } from "./store.ts";

/** 门控四态 */
export type GateState = "passed" | "failed" | "none" | "stale";

/** 容差窗口（毫秒）：验证时间与正文修改时间在此窗口内视为“新鲜”。
 * 抵消粗粒度文件系统（容器挂载/SMB/FAT32）的时间戳取整，以及“写实体→追加记录”同时刻竞争导致的顺序反转。
 * 偏大无实际代价：正文修改是低频手动操作，改动后几秒内被采信的概率趋近于零。 */
const GRACE_MS = 3_000;

/** 门控徽标文本 */
export const GATE_LABEL: Record<GateState, string> = {
	passed: "✅ passed",
	failed: "⚠️ failed",
	none: "❓ unverified",
	stale: "⏳ stale (re-verify)",
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
 * - 最新记录晚于实体最近修改 → 按记录结果 passed/failed
 * - 最新记录早于实体最近修改 → stale（待复验）：正文改过，旧验证不再匹配
 */
export function computeGate(meta: EntityMeta, verifications: VerificationRecord[]): GateResult {
	const latest = verifications.length
		? verifications.reduce((a, b) => (b.checkedAtMs > a.checkedAtMs ? b : a))
		: null;
	let state: GateState;
	if (!latest) {
		state = "none";
	} else if (latest.checkedAtMs > 0 && latest.checkedAtMs < meta.mtimeMs - GRACE_MS) {
		state = "stale";
	} else {
		state = latest.result;
	}
	return { state, latest, entityMtimeMs: meta.mtimeMs };
}

/** 实体与门控结果配对（gateLibrary 的返回项） */
export interface GatedEntity {
	meta: EntityMeta;
	gate: GateResult;
}

/** 待验证实体清单项：命令算好清单传给 agent 提示词 */
export interface PendingEntity {
	id: string;
	kind: string;
	state: GateState;
}

/** 需要（重新）验证的门控状态：未证实 + 过期 */
export const NEEDS_VERIFICATION: ReadonlySet<GateState> = new Set<GateState>(["none", "stale"]);

/** 门控实体 → 待验清单项（清单注入提示词用：手动命令与自动挡共用此转换） */
export function toPending(gated: GatedEntity[]): PendingEntity[] {
	return gated.map(({ meta, gate }) => ({ id: meta.id, kind: meta.kind, state: gate.state }));
}

/** 待验实体摘要：overview 展示用（四态计数 + 待验实体清单） */
export interface LibrarySummary {
	/** 四态计数 */
	counts: Record<GateState, number>;
	/** 需要验证的实体（unverified/stale）及其状态 */
	pending: { id: string; state: GateState }[];
}

/** 全库统计摘要：一次性攒齐四态计数与待验清单（纯计算，供 /memory overview 展示） */
export function summarizeLibrary(gated: GatedEntity[]): LibrarySummary {
	const counts: Record<GateState, number> = { passed: 0, failed: 0, none: 0, stale: 0 };
	const pending: { id: string; state: GateState }[] = [];
	for (const { meta, gate } of gated) {
		counts[gate.state]++;
		if (NEEDS_VERIFICATION.has(gate.state)) pending.push({ id: meta.id, state: gate.state });
	}
	return { counts, pending };
}

/** 待验实体选取：指定 id 时全量复验该实体（含 passed/failed）；未指定时只挑 unverified/stale */
export function selectPending(gated: GatedEntity[], targetId?: string): GatedEntity[] {
	if (!targetId) return gated.filter((g) => NEEDS_VERIFICATION.has(g.gate.state));
	return gated.filter((g) => g.meta.id === targetId);
}

/** 批量门控：整库实体 → 门控结果（纯计算，不 IO） */
export function gateLibrary(items: EntityWithVerifications[]): GatedEntity[] {
	return items.map(({ meta, verifications }) => ({ meta, gate: computeGate(meta, verifications) }));
}
