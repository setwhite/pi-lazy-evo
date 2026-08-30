/**
 * auto 自动挡单元测试：纯函数（触发判定 / 尾部落盘 / 切块 / 库快照 diff）+ 钩子的宿主归属。
 * 全程不真正 spawn worker（无 API 消耗）：钩子用例只走 session_shutdown（纯 IO）与无头早退路径。
 * 子进程通道见 worker.test.ts，素材与提示词见 prompts.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	autoHooksEnabled,
	clearPendingTail,
	collectTranscriptWithPending,
	decideAutoTrigger,
	hasPendingTail,
	INITIAL_AUTO_STATE,
	registerAutoModeHooks,
	splitPending,
	writePendingTail,
} from "../extension/auto.ts";
import { Runtime } from "../extension/index.ts";
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

/**
 * 钩子注册的宿主归属：worker 子进程同样加载本扩展并走完整个 session 生命周期，
 * 且与宿主共用同一记忆库目录——必须在钩子入口即早退。
 * 用例只驱动 session_shutdown（纯 IO）与 json 早退路径，不触发 spawn。
 */
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
