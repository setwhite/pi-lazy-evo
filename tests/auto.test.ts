/**
 * auto 自动挡单元测试：只测纯函数（触发判定 / 素材抽取 / 提示词与参数组装），
 * 不真正 spawn pi 子进程。覆盖四态判定、compaction 回落、防并发、模型参数。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAutoWorkerArgs, closeOutcome, decideAutoTrigger, diffLibrary, formatChanges, INITIAL_AUTO_STATE, snapshotLibrary } from "../extension/auto.ts";
import { buildAgentPrompt, buildWorkerPrompt, extractTranscript, recordTask, verifyTask } from "../extension/prompts.ts";
import { appendVerification, memoryDir, writeEntity } from "../extension/store.ts";

/** 收集本次用例生成的临时 worker 目录，统一清理 */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withCleanup<const T extends { promptDir: string }>(built: T): T {
	tempDirs.push(built.promptDir);
	return built;
}

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

describe("extractTranscript", () => {
	it("只取 message 条目，按 role: text 拼接，截断最近几条", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "a" } },
			{ type: "model_change", provider: "x", modelId: "y" },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
		];
		const out = extractTranscript(entries, 10);
		expect(out).toContain("user: a");
		expect(out).toContain("assistant: b");
		expect(out).not.toContain("provider");
	});

	it("尊重 limit：只取最近 N 条", () => {
		const entries = Array.from({ length: 5 }, (_, i) => ({ type: "message" as const, message: { role: "user" as const, content: `m${i}` } }));
		const out = extractTranscript(entries, 3);
		expect(out).not.toContain("m0");
		expect(out).toContain("m2");
	});
});

describe("任务与提示词", () => {
	it("record 任务只含实体面：不引用验证面", () => {
		const task = recordTask("t");
		expect(task.formats).toEqual(["entities.md"]);
		expect(task.formats).not.toContain("verifications.md");
		expect(task.manuals).not.toContain("verify.md");
	});

	it("验证任务含实体面+验证面，不引用 record 手册", () => {
		const task = verifyTask([{ id: "x", kind: "tool", state: "stale" }]);
		expect(task.formats).toEqual(["entities.md", "verifications.md"]);
		expect(task.manuals).toEqual(["verify.md"]);
		expect(task.material).toContain("- x [tool] ⏳ 已过期（需复验）");
	});

	it("worker 提示词：含手册引用、素材与约束", () => {
		const prompt = buildWorkerPrompt(recordTask("hello"), "/p/protocol", "/w", 8);
		expect(prompt).toContain(join("/p/protocol", "entities.md"));
		expect(prompt).toContain(join("/p/protocol", "record.md"));
		expect(prompt).not.toContain("verifications.md");
		expect(prompt).toContain(memoryDir("/w"));
		expect(prompt).toContain("hello");
		expect(prompt).toContain("最多 8");
	});

	it("worker 提示词：记忆库根尊重 MEMORY_DIR 覆盖", () => {
		process.env.MEMORY_DIR = "/custom/memory";
		try {
			const prompt = buildWorkerPrompt(recordTask(), "/p/protocol", "/w", 8);
			expect(prompt).toContain("/custom/memory");
			expect(prompt).not.toContain("/w/.memory");
		} finally {
			delete process.env.MEMORY_DIR;
		}
	});

	it("主会话提示词：精简无约束，含手册与素材", () => {
		const prompt = buildAgentPrompt(verifyTask([{ id: "x", kind: "concept", state: "none" }]), "/p/protocol");
		expect(prompt).toContain(join("/p/protocol", "verify.md"));
		expect(prompt).toContain("- x [concept] ❓ 未验证");
		expect(prompt).not.toContain("at most");
	});
});

describe("buildAutoWorkerArgs", () => {
	it("配置了便宜模型：组装 --model provider/id 与 --thinking，写提示词文件", () => {
		const built = withCleanup(buildAutoWorkerArgs({ model: { provider: "openrouter", id: "a-model", thinking: "low" }, tools: ["read", "bash"], promptContent: "P" }));
		expect(built.args).toContain("--model");
		expect(built.args).toContain("openrouter/a-model");
		expect(built.args).toContain("--thinking");
		expect(built.args).toContain("--append-system-prompt");
		expect(existsSync(built.promptFile)).toBe(true);
	});

	it("未配置模型：不带 --model，仍写提示词文件", () => {
		const built = withCleanup(buildAutoWorkerArgs({ promptContent: "P", tools: ["read"] }));
		expect(built.args).not.toContain("--model");
		expect(built.args.some((a) => a === "--mode" || a === "-p" || a === "--no-session")).toBe(true);
	});

	it("工具白名单以逗号拼接传给 --tools（默认验证集含 web）", () => {
		const built = withCleanup(buildAutoWorkerArgs({ promptContent: "P", tools: ["read", "grep", "bash", "web_search", "web_fetch"] }));
		const idx = built.args.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(built.args[idx + 1]).toBe("read,grep,bash,web_search,web_fetch");
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
		expect(formatChanges("record", { addedEntities: ["a", "b"], updatedEntities: ["c"], newVerifications: [] })).toBe("+ a, b　~ c");
		expect(formatChanges("record", { addedEntities: [], updatedEntities: ["c"], newVerifications: [] })).toBe("~ c");
		expect(formatChanges("record", { addedEntities: [], updatedEntities: [], newVerifications: [] })).toBe("无变化");
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
		expect(formatChanges("verify", changes)).toBe("+ 验证：a ✅, b ⚠️");
		expect(formatChanges("verify", { addedEntities: [], updatedEntities: [], newVerifications: [] })).toBe("无变化");
	});
});

describe("closeOutcome", () => {
	it("正常退出（code 0）：无文本时用兜底文案", () => {
		expect(closeOutcome({ code: 0, hitLimit: false, lastAssistant: "done" })).toEqual({ ok: true, text: "done" });
		expect(closeOutcome({ code: 0, hitLimit: false, lastAssistant: "" })).toEqual({ ok: true, text: "已执行（无文本输出）" });
	});

	it("命中轮数上限被 SIGKILL（code null）算正常结束，不误报失败", () => {
		expect(closeOutcome({ code: null, hitLimit: true, lastAssistant: "部分完成" })).toEqual({ ok: true, text: "部分完成" });
		expect(closeOutcome({ code: null, hitLimit: true, lastAssistant: "" })).toEqual({ ok: true, text: "已达轮数上限（无文本输出）" });
	});

	it("非零退出码判失败", () => {
		expect(closeOutcome({ code: 1, hitLimit: false, lastAssistant: "" })).toEqual({ ok: false, text: "worker 退出码 1" });
	});
});
