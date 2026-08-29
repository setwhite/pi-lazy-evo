/**
 * auto 自动挡单元测试：只测纯函数（触发判定 / 尾部落盘 / 切块 / 库快照 diff），
 * 不真正 spawn worker。子进程通道见 worker.test.ts，素材与提示词见 prompts.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPendingTail, collectTranscriptWithPending, decideAutoTrigger, hasPendingTail, INITIAL_AUTO_STATE, splitPending, writePendingTail } from "../extension/auto.ts";
import { diffLibrary, formatChanges, snapshotLibrary } from "../extension/library.ts";
import { appendVerification, memoryDir, writeEntity } from "../extension/store.ts";

describe("decideAutoTrigger", () => {
	it("首次观察吸收基线，不触发", () => {
		const { trigger, state } = decideAutoTrigger(INITIAL_AUTO_STATE, 20_000, 50_000);
		expect(trigger).toBe(false);
		expect(state.baselineTokens).toBe(20_000);
		expect(state.initialized).toBe(true);
	});

	it("增量未达阈值不触发", () => {
		const after = decideAutoTrigger(INITIAL_AUTO_STATE, 10_000, 50_000).state;
		const { trigger } = decideAutoTrigger(after, 30_000, 50_000);
		expect(trigger).toBe(false);
	});

	it("增量达阈值触发一次，基线推进到当前", () => {
		const after = decideAutoTrigger(INITIAL_AUTO_STATE, 10_000, 50_000).state;
		const { trigger, state } = decideAutoTrigger(after, 70_000, 50_000);
		expect(trigger).toBe(true);
		expect(state.baselineTokens).toBe(70_000);
	});

	it("compaction 后 tokens 回落：重设基线且不触发", () => {
		const after = decideAutoTrigger(INITIAL_AUTO_STATE, 80_000, 50_000).state;
		const { trigger, state } = decideAutoTrigger(after, 10_000, 50_000);
		expect(trigger).toBe(false);
		expect(state.baselineTokens).toBe(10_000);
	});

	it("worker 在跑时吸收增量、不重复触发", () => {
		const after = { ...decideAutoTrigger(INITIAL_AUTO_STATE, 10_000, 50_000).state, inFlight: true };
		const { trigger, state } = decideAutoTrigger(after, 80_000, 50_000);
		expect(trigger).toBe(false);
		expect(state.baselineTokens).toBe(80_000);
	});
});

describe("会话边界尾部落盘", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-tail-"));
		process.env.MEMORY_DIR = join(cwd, ".memory");
	});
	afterEach(() => {
		delete process.env.MEMORY_DIR;
	});

	it("落盘后可并入下次 record 素材", () => {
		writePendingTail(cwd, "旧会话尾巴素材");
		expect(collectTranscriptWithPending(cwd, "当前会话素材")).toBe("当前会话素材\n\n[上一会话未固化尾部]\n旧会话尾巴素材");
	});

	it("无落盘时素材原样", () => {
		expect(collectTranscriptWithPending(cwd, "t")).toBe("t");
	});

	it("hasPendingTail：无文件/空文件为假，落盘后为真，消费后回假", () => {
		expect(hasPendingTail(cwd)).toBe(false);
		writePendingTail(cwd, "   ");
		expect(hasPendingTail(cwd)).toBe(false); // 纯空白视为无
		writePendingTail(cwd, "tail");
		expect(hasPendingTail(cwd)).toBe(true);
		clearPendingTail(cwd);
		expect(hasPendingTail(cwd)).toBe(false);
	});

	it("record 成功后清理：清理后不再并入", () => {
		writePendingTail(cwd, "tail");
		clearPendingTail(cwd);
		expect(collectTranscriptWithPending(cwd, "t")).toBe("t");
		expect(existsSync(join(memoryDir(cwd), "pending.md"))).toBe(false);
	});
});

describe("库快照 diff", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-diff-"));
		process.env.MEMORY_DIR = join(cwd, ".memory");
	});
	afterEach(() => {
		delete process.env.MEMORY_DIR;
	});

	it("record diff：新增/更新实体；无变化为空", async () => {
		const before = snapshotLibrary(cwd);
		writeEntity(cwd, { id: "a", kind: "tool", sources: "s", assertions: ["A."] });
		const added = diffLibrary(before, snapshotLibrary(cwd));
		expect(added.addedEntities).toEqual(["a"]);
		expect(added.updatedEntities).toEqual([]);
		const mid = snapshotLibrary(cwd);
		await Bun.sleep(5); // 保证 mtime 变化（两次写入可能落在同一毫秒）
		writeEntity(cwd, { id: "a", kind: "tool", sources: "s", assertions: ["A.", "B."] });
		const updated = diffLibrary(mid, snapshotLibrary(cwd));
		expect(updated.addedEntities).toEqual([]);
		expect(updated.updatedEntities).toEqual(["a"]);
		expect(diffLibrary(snapshotLibrary(cwd), snapshotLibrary(cwd))).toEqual({ addedEntities: [], updatedEntities: [], newVerifications: [] });
	});

	it("verify diff：新增验证记录带实体 id 与 result", () => {
		appendVerification(cwd, { entityId: "a", validator: "v", result: "passed", body: "e1" });
		const before = snapshotLibrary(cwd);
		appendVerification(cwd, { entityId: "b", validator: "v", result: "failed", body: "e2" });
		const changes = diffLibrary(before, snapshotLibrary(cwd));
		expect(changes.newVerifications).toEqual([{ id: "b", result: "failed" }]);
	});
});

describe("formatChanges", () => {
	it("record 文案：新增/更新拼接；无变化", () => {
		expect(formatChanges("record", { addedEntities: ["a", "b"], updatedEntities: ["c"], newVerifications: [] })).toBe("+ a, b | ~ c");
		expect(formatChanges("record", { addedEntities: [], updatedEntities: ["c"], newVerifications: [] })).toBe("~ c");
		expect(formatChanges("record", { addedEntities: [], updatedEntities: [], newVerifications: [] })).toBe("no changes");
	});

	it("verify 文案：带 ✅/⚠️ 结果；无变化", () => {
		const changes = {
			addedEntities: [],
			updatedEntities: [],
			newVerifications: [
				{ id: "a", result: "passed" as const },
				{ id: "b", result: "failed" as const },
			],
		};
		expect(formatChanges("verify", changes)).toBe("+ verified: a ✅, b ⚠️");
		expect(formatChanges("verify", { addedEntities: [], updatedEntities: [], newVerifications: [] })).toBe("no changes");
	});
});

describe("splitPending", () => {
	const item = (id: string): import("../extension/gate.ts").PendingEntity => ({ id, kind: "tool", state: "none" });

	it("空清单返回空数组", () => {
		expect(splitPending([])).toEqual([]);
	});

	it("实体数不超过并发上限：每实体一块", () => {
		const chunks = splitPending([item("a"), item("b"), item("c"), item("d")]);
		expect(chunks).toHaveLength(4);
		expect(chunks.flat().map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("实体数超过并发上限：块数 ≤ 上限，且不丢不重", () => {
		const many = Array.from({ length: 20 }, (_, i) => item(`e${i}`));
		const chunks = splitPending(many);
		expect(chunks.length).toBeLessThanOrEqual(8);
		expect(chunks.flat().map((c) => c.id)).toEqual(many.map((c) => c.id));
	});

	it("边界：9 个实体切成 5 块（每块 ≤ 2）", () => {
		const many = Array.from({ length: 9 }, (_, i) => item(`e${i}`));
		const chunks = splitPending(many);
		expect(chunks.length).toBe(5);
		expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(2);
	});
});
