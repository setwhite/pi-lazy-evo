/**
 * 门控域：实体信任状态推导（纯计算，不 IO）。
 * 状态永远由"实体正文 mtime / 依赖文件 mtime vs 最新验证记录时间"实时推出，不落盘、每次现算。
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

/** 需要修正的门控状态：验证失败——先修正正文再复验，禁止对未修正正文重复验证 */
export const NEEDS_FIX: ReadonlySet<GateState> = new Set(["failed"]);

/** 实体与门控结果配对（gateLibrary 返回项） */
export interface GatedEntity {
	meta: EntityWithVerifications["meta"];
	gate: GateResult;
}

/** 批量门控：整库配对 → 门控结果 */
export function gateLibrary(items: EntityWithVerifications[]): GatedEntity[] {
	return items.map(({ meta, verifications }) => ({ meta, gate: computeGate(meta, verifications) }));
}

/** 依赖失效覆盖：passed 实体但某 depends-on 文件在该次验证之后被修改（mtime 晚于 checked_at 超容差）→ stale。
 * 纯推导无基线缓存：比较锚点是最新验证记录时刻，复验通过即自愈；依赖缺失（depMtime 返回 null）不置 stale。
 * 非 passed 态（none/failed/stale）本就在待办队列，不重复处理。 */
export function applyDepStaleness(gated: GatedEntity[], depMtime: (relPath: string) => number | null): void {
	for (const g of gated) {
		if (g.gate.state !== "passed" || !g.gate.latest) continue;
		const after = g.gate.latest.checkedAtMs + GRACE_MS;
		if (g.meta.dependsOn.some((rel) => {
			const m = depMtime(rel);
			return m !== null && m > after;
		})) g.gate.state = "stale";
	}
}

/** 待验实体选取：指定 id 时全量复验该实体（含 passed/failed）；未指定挑 none/stale（验证）+ failed（修正），保持原顺序 */
export function selectPending(gated: GatedEntity[], targetId?: string): GatedEntity[] {
	if (!targetId) return gated.filter((g) => NEEDS_VERIFICATION.has(g.gate.state) || NEEDS_FIX.has(g.gate.state));
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

/** 全库摘要：四态计数 + 待验清单 + 待修正清单（overview 展示用） */
export interface LibrarySummary {
	counts: Record<GateState, number>;
	/** 待验证：none / stale */
	pending: { id: string; state: GateState }[];
	/** 待修正：failed（先修正正文再复验，第一优先） */
	fix: { id: string; state: GateState }[];
}

/** 全库统计摘要：四态计数、待验与待修正清单一次算齐 */
export function summarizeLibrary(gated: GatedEntity[]): LibrarySummary {
	const counts = Object.fromEntries(GATE_STATES.map((s) => [s, 0])) as Record<GateState, number>;
	const pending: { id: string; state: GateState }[] = [];
	const fix: { id: string; state: GateState }[] = [];
	for (const { meta, gate } of gated) {
		counts[gate.state]++;
		if (NEEDS_VERIFICATION.has(gate.state)) pending.push({ id: meta.id, state: gate.state });
		if (NEEDS_FIX.has(gate.state)) fix.push({ id: meta.id, state: gate.state });
	}
	return { counts, pending, fix };
}