/**
 * hooks/auto 单元测试：只测纯函数（触发判定 / 素材抽取 / 提示词与参数组装），
 * 不真正 spawn pi 子进程。覆盖四态判定、compaction 回落、防并发、模型参数。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {
	decideAutoTrigger,
	INITIAL_AUTO_STATE,
} from "../hooks/auto.ts";
import { extractTranscript, buildMemoWorkerPrompt } from "../hooks/memo-worker.ts";
import { buildVerifyWorkerPrompt } from "../hooks/verify-worker.ts";
import { buildAutoWorkerArgs } from "../hooks/worker.ts";

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

describe("worker 提示词", () => {
	it("沉淀提示词：含 record 手册、记忆库根与素材", () => {
		const prompt = buildMemoWorkerPrompt({ protocolDir: "/p/protocol", cwd: "/w", transcript: "hello", maxTurns: 8 });
		expect(prompt).toContain("/p/protocol/entities.md");
		expect(prompt).toContain("/p/protocol/record.md");
		expect(prompt).not.toContain("verifications.md");
		expect(prompt).toContain("/w/.memory");
		expect(prompt).toContain("hello");
		expect(prompt).toContain("最多 8 轮");
	});

	it("验证提示词：含 verify 手册与记忆库根，不带素材字段", () => {
		const prompt = buildVerifyWorkerPrompt({ protocolDir: "/p/protocol", cwd: "/w", maxTurns: 6 });
		expect(prompt).toContain("/p/protocol/entities.md");
		expect(prompt).toContain("/p/protocol/verifications.md");
		expect(prompt).toContain("/p/protocol/verify.md");
		expect(prompt).not.toContain("record.md");
		expect(prompt).toContain("/w/.memory");
		expect(prompt).not.toContain("最近对话素材");
		expect(prompt).toContain("最多 6 轮");
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
