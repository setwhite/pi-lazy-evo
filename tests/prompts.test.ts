/**
 * prompts 域单元测试：素材抽取与任务纯数据（手动命令与 auto worker 共用同一套语义）。
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildAgentPrompt, buildWorkerPrompt, extractTranscript, recordTask, verifyTask } from "../extension/prompts.ts";
import { memoryDir } from "../extension/store.ts";

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