/**
 * gate 层单元测试：纯构造输入（不 IO），覆盖四态判定、
 * GRACE 容差窗口、批量门控与逐实体一致性。
 */
import { describe, expect, it } from "bun:test";
import { computeGate, gateLibrary, NEEDS_VERIFICATION, selectPending, summarizeLibrary, type GatedEntity } from "../core/gate.ts";
import type { EntityMeta, EntityWithVerifications, VerificationRecord } from "../core/store.ts";

/** 构造实体元信息（默认 mtime 距今 1 小时前） */
function meta(over: Partial<EntityMeta> = {}): EntityMeta {
	return {
		id: "t",
		path: "/tmp/.memory/entities/t.md",
		kind: "tool",
		sources: "unit test",
		mtimeMs: Date.now() - 3_600_000,
		...over,
	};
}

/** 构造验证记录（默认最新时刻，可直接覆盖） */
function rec(over: Partial<VerificationRecord> = {}): VerificationRecord {
	return {
		path: "/tmp/.memory/verifications/v.md",
		target: "entities/t.md",
		validator: "unit",
		checkedAt: "",
		result: "passed",
		evidence: "e",
		checkedAtMs: Date.now(),
		...over,
	};
}

describe("computeGate 四态", () => {
	it("无验证记录 → none", () => {
		expect(computeGate(meta(), []).state).toBe("none");
	});

	it("最新 passed 且晚于实体修改 → passed", () => {
		const m = meta({ mtimeMs: Date.now() - 60_000 });
		expect(computeGate(m, [rec({ checkedAtMs: Date.now() })]).state).toBe("passed");
	});

	it("最新 failed 且晚于实体修改 → failed", () => {
		const m = meta({ mtimeMs: Date.now() - 60_000 });
		expect(computeGate(m, [rec({ result: "failed", checkedAtMs: Date.now() })]).state).toBe("failed");
	});

	it("最新记录早于实体修改（超出容差）→ stale", () => {
		const m = meta({ mtimeMs: Date.now() });
		expect(computeGate(m, [rec({ checkedAtMs: m.mtimeMs - 10_000 })]).state).toBe("stale");
	});

	it("GRACE 容差窗口内的时间反转不降级为 stale", () => {
		const m = meta({ mtimeMs: Date.now() });
		expect(computeGate(m, [rec({ checkedAtMs: m.mtimeMs - 1_000 })]).state).toBe("passed");
	});

	it("多条记录取 checked_at 最新者", () => {
		const m = meta({ mtimeMs: Date.now() - 60_000 });
		const old = rec({ checkedAtMs: Date.now() - 10_000 });
		const state = computeGate(m, [old, rec({ result: "failed", checkedAtMs: Date.now() })]).state;
		expect(state).toBe("failed");
	});
});

describe("gateLibrary 批量门控", () => {
	it("与逐实体 computeGate 结果一致", () => {
		const items: EntityWithVerifications[] = [
			{ meta: meta({ id: "a", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/a.md", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "b", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/b.md", result: "failed", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "c", mtimeMs: Date.now() }), verifications: [] },
		];
		const gated: GatedEntity[] = gateLibrary(items);
		for (const g of gated) {
			const expected = computeGate(g.meta, items.find((i) => i.meta.id === g.meta.id)!.verifications).state;
			expect(g.gate.state).toBe(expected);
		}
		expect(gated.map((g) => g.gate.state)).toEqual(["passed", "failed", "none"]);
	});
});

describe("NEEDS_VERIFICATION", () => {
	it("只含 none 与 stale", () => {
		expect([...NEEDS_VERIFICATION].sort()).toEqual(["none", "stale"]);
	});
});

describe("summarizeLibrary 全库摘要", () => {
	it("四态计数与待验清单一次算齐", () => {
		const items: EntityWithVerifications[] = [
			{ meta: meta({ id: "a", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/a.md", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "b", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/b.md", result: "failed", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "c", mtimeMs: Date.now() }), verifications: [] },
			{ meta: meta({ id: "d", mtimeMs: Date.now() }), verifications: [rec({ target: "entities/d.md", checkedAtMs: Date.now() - 10_000 })] },
		];
		const { counts, pending } = summarizeLibrary(gateLibrary(items));
		expect(counts).toEqual({ passed: 1, failed: 1, none: 1, stale: 1 });
		expect(pending.map((p) => p.id)).toEqual(["c", "d"]);
	});
});

describe("selectPending 待验选取", () => {
	it("未指定 id 时只挑 unverified/stale，且保持原顺序", () => {
		const items: EntityWithVerifications[] = [
			{ meta: meta({ id: "a", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/a.md", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "b", mtimeMs: Date.now() }), verifications: [] },
		];
		expect(selectPending(gateLibrary(items)).map((g) => g.meta.id)).toEqual(["b"]);
	});

	it("指定 id 时全量复验（含 passed），找不到返回空", () => {
		const items: EntityWithVerifications[] = [
			{ meta: meta({ id: "a", mtimeMs: Date.now() - 60_000 }), verifications: [rec({ target: "entities/a.md", checkedAtMs: Date.now() })] },
			{ meta: meta({ id: "b", mtimeMs: Date.now() }), verifications: [] },
		];
		expect(selectPending(gateLibrary(items), "a").map((g) => g.meta.id)).toEqual(["a"]);
		expect(selectPending(gateLibrary(items), "ghost")).toHaveLength(0);
	});
});