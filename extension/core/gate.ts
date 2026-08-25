/**
 * 门控域整体逻辑：批量门控、待验清单筛选、全库摘要（纯计算，不 IO）。
 * 单实体四态判定（确定性小工具）在 tools/gate.ts，此处透出保持调用方路径稳定。
 */
import { computeGate, GATE_STATES, type GateResult, type GateState } from "../tools/gate.ts";
import type { EntityWithVerifications } from "./store.ts";

export { GATE_LABEL, GRACE_MS, computeGate, type GateResult, type GateState } from "../tools/gate.ts";

/** 实体与门控结果配对（gateLibrary 的返回项） */
export interface GatedEntity {
	meta: EntityWithVerifications["meta"];
	gate: GateResult;
}

/** 待验证实体清单项：命令算好清单传给 agent 提示词 */
export interface PendingEntity {
	id: string;
	kind: string;
	state: GateState;
}

/** 需要（重新）验证的门控状态：未证实 + 过期 */
export const NEEDS_VERIFICATION: ReadonlySet<GateState> = new Set(["none", "stale"]);

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
	const counts = Object.fromEntries(GATE_STATES.map((s) => [s, 0])) as Record<GateState, number>;
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
