/**
 * auto 自动挡单元测试：纯函数（触发判定 / 增量清单 / 波次并发 /存量提醒 / 库快照 diff）+ 钩子的宿主归属。
 * 尾部暂存本体见 store.test.ts；全程不真正 spawn worker（无 API 消耗）：钩子用例只走 session_shutdown（纯 IO）与无头早退路径。
 * 子进程通道见 worker.test.ts，素材与提示词见 prompts.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoHooksEnabled,
	autoVerifyTargets,
	backlogLines,
	decideAutoTrigger,
	INITIAL_AUTO_STATE,
	leftoverStock,
	registerAutoModeHooks,
	runBounded,
} from "../extension/auto.ts";
import { Runtime } from "../extension/index.ts";
import { diffLibrary, formatChanges, snapshotLibrary, type LibraryChanges } from "../extension/library.ts";
import type { GatedEntity, GateState } from "../extension/gate.ts";
import {
	appendVerification,
	hasPendingTail,
	memoryDir,
	writeEntity,
	writePendingTail,
} from "../extension/store.ts";

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

describe("autoHooksEnabled（一次性无头模式不参与 auto 挡）", () => {
	it("交互会话与 rpc 宿主生效", () => {
		expect(autoHooksEnabled("tui")).toBe(true);
		expect(autoHooksEnabled("rpc")).toBe(true);
	});

	it("worker 的 json / print 模式不生效（否则递归 spawn + pending.md 被覆盖）", () => {
		expect(autoHooksEnabled("json")).toBe(false);
		expect(autoHooksEnabled("print")).toBe(false);
	});
});

describe("auto 钩子的宿主归属", () => {
	/** 事件名 → 处理器（registerAutoModeHooks 注册进假 pi） */
	type Handlers = Map<string, (event: unknown, ctx: unknown) => unknown>;
	/** 最小 ctx 视口：只填 auto 钩子实际读取的字段 */
	interface FakeCtx {
		mode: string;
		cwd: string;
		sessionManager: { getEntries: () => unknown[] };
		ui: { setWidget: () => void; notify: () => void };
		getContextUsage: () => { tokens: number };
	}

	let cwd: string;
	let handlers: Handlers;
	/** session_start 是否碰过活动面板（守卫失效则先清面板再 spawn） */
	let widgetTouched: boolean;

	const pendingPath = (): string => join(memoryDir(cwd), "pending.md");
	const readPending = (): string => readFileSync(pendingPath(), "utf8");

	function fakeCtx(mode: string, entries: unknown[]): FakeCtx {
		return {
			mode,
			cwd,
			sessionManager: { getEntries: () => entries },
			ui: { setWidget: () => (widgetTouched = true), notify: () => {} },
			getContextUsage: () => ({ tokens: 0 }),
		};
	}

	async function fire(type: string, ctx: FakeCtx): Promise<void> {
		await handlers.get(type)?.({}, ctx);
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-hooks-"));
		process.env.MEMORY_DIR = join(cwd, ".memory");
		widgetTouched = false;
		// 挡位只存全局 settings：临时文件置 auto，让钩子进入"本会干活"分支
		process.env.PI_GLOBAL_SETTINGS_FILE = join(cwd, "settings.json");
		writeFileSync(process.env.PI_GLOBAL_SETTINGS_FILE, JSON.stringify({ "pi-lazy-evo": { mode: "auto" } }));
		// 每个用例重新注册：state 是 registerAutoModeHooks 的闭包
		handlers = new Map();
		const pi = { on: (type: string, h: unknown) => handlers.set(type, h as never) } as unknown as ExtensionAPI;
		registerAutoModeHooks(pi, new Runtime(pi, join(cwd, "protocol")));
	});
	afterEach(() => {
		delete process.env.MEMORY_DIR;
		delete process.env.PI_GLOBAL_SETTINGS_FILE;
	});

	const entry = { type: "message", message: { role: "user", content: "宿主会话素材" } };

	it("worker（json）退出不落盘：不得覆盖宿主未固化的尾部素材", async () => {
		writePendingTail(cwd, "宿主真实素材");
		await fire("session_shutdown", fakeCtx("json", [entry]));
		expect(readPending()).toBe("宿主真实素材");
	});

	it("worker（print）退出不落盘", async () => {
		await fire("session_shutdown", fakeCtx("print", [entry]));
		expect(hasPendingTail(cwd)).toBe(false);
	});

	it("交互会话退出才落盘会话尾部", async () => {
		await fire("session_shutdown", fakeCtx("tui", [entry]));
		expect(readPending()).toContain("宿主会话素材");
	});

	it("worker（json）的 session_start 不启动冲刷（pending.md 在则会递归 spawn）", async () => {
		writePendingTail(cwd, "tail");
		await fire("session_start", fakeCtx("json", []));
		expect(widgetTouched).toBe(false);
		expect(readPending()).toBe("tail");
	});

	it("worker（json）的 turn_end 不参与水位判定", async () => {
		await fire("turn_end", fakeCtx("json", [entry]));
		expect(widgetTouched).toBe(false);
		expect(hasPendingTail(cwd)).toBe(false);
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
		expect(formatChanges("verify", changes)).toBe("a ✅, b ⚠️");
		expect(formatChanges("verify", { addedEntities: [], updatedEntities: [], newVerifications: [] })).toBe("no changes");
	});
});

describe("autoVerifyTargets", () => {
	const gated = (id: string, state: GateState): GatedEntity => ({
		meta: { id } as GatedEntity["meta"],
		gate: { state } as GatedEntity["gate"],
	});
	const changes = (added: string[], updated: string[]): LibraryChanges => ({ addedEntities: added, updatedEntities: updated, newVerifications: [] });

	it("只挑本轮 record 新增/更新的实体（增量语义，存量积压不重验）", () => {
		const all = [gated("a", "none"), gated("b", "stale"), gated("c", "failed"), gated("d", "passed")];
		expect(autoVerifyTargets(all, changes(["a"], ["c"])).map((p) => p.id)).toEqual(["a", "c"]);
	});

	it("本轮无变化返回空清单", () => {
		expect(autoVerifyTargets([gated("a", "stale")], changes([], []))).toEqual([]);
	});

	it("diff 里有但库中不存在的 id（如随后被删）跳过", () => {
		expect(autoVerifyTargets([], changes(["gone"], []))).toEqual([]);
	});
});

describe("leftoverStock / backlogLines（存量提醒）", () => {
	const gated = (id: string, state: GateState): GatedEntity => ({
		meta: { id } as GatedEntity["meta"],
		gate: { state } as GatedEntity["gate"],
	});
	const pending = (id: string, state: GateState): import("../extension/gate.ts").PendingEntity => ({ id, kind: "tool", state });

	it("存量积压 = 全库待办减去本轮已验对象", () => {
		const all = [gated("a", "none"), gated("b", "stale"), gated("c", "failed"), gated("d", "passed")];
		expect(leftoverStock(all, [pending("a", "none"), pending("c", "failed")]).map((p) => p.id)).toEqual(["b"]);
	});

	it("无积压：backlogLines 返回空；有积压：提醒行指向 verify all", () => {
		expect(backlogLines([])).toEqual([]);
		expect(backlogLines([pending("b", "stale")])[0]).toBe("backlog 1: b — run /memory verify all to clear.");
	});

	it("超长 id 清单折叠为预览 + 计数", () => {
		const many = Array.from({ length: 10 }, (_, i) => pending(`e${i}`, "none"));
		const line = backlogLines(many)[0];
		expect(line).toContain("backlog 10: e0, e1, e2, e3, e4, e5, e6, e7, … +2");
	});
});

describe("runBounded", () => {
	it("空清单返回空结果", async () => {
		expect(await runBounded([], 3, async () => {})).toEqual([]);
	});

	it("全部执行不丢不重", async () => {
		const seen: number[] = [];
		const results = await runBounded([1, 2, 3, 4, 5], 2, async (n) => void seen.push(n));
		expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
	});

	it("并发峰值不超上限", async () => {
		let running = 0;
		let peak = 0;
		await runBounded(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
			running++;
			peak = Math.max(peak, running);
			await Bun.sleep(1);
			running--;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});

	it("单个失败不中断整批，结果逐个收集", async () => {
		const results = await runBounded([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error("boom");
		});
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
	});
});
