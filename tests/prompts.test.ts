/**
 * prompts 域单元测试：任务纯数据结构、主会话提示词组装。
 * 规则细节归 protocol 手册，提示词只指引阅读——断言据此设定（不复述手册内容）。
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildAgentPrompt, queryTask, recordTask, verifyTask } from "../extension/prompts.ts";
import { memoryDir } from "../extension/store.ts";

describe("任务纯数据", () => {
	it("record 任务只含实体面：不引用验证面", () => {
		const task = recordTask("只记 git 相关");
		expect(task.formats).toEqual(["entities.md"]);
		expect(task.formats).not.toContain("verifications.md");
		expect(task.manuals).not.toContain("verify.md");
		expect(task.material).toContain("用户附注（限定记录范围）：只记 git 相关");
	});

	it("record 无附注时 material 缺省——素材即代理当前会话，不重复喂入", () => {
		const task = recordTask();
		expect(task.material).toBeUndefined();
		expect(task.instructions).toContain("本次会话");
	});

	it("验证任务含实体面+验证面，不引用 record 手册", () => {
		const task = verifyTask([{ id: "x", kind: "tool", state: "stale" }]);
		expect(task.formats).toEqual(["entities.md", "verifications.md"]);
		expect(task.manuals).toEqual(["verify.md"]);
		expect(task.material).toContain("- x [tool] ⏳ 已过期（需复验）");
	});

	it("验证任务：failed 实体进待修正段（排在待验证段前），其余进待验证段", () => {
		const task = verifyTask([
			{ id: "bad", kind: "concept", state: "failed" },
			{ id: "new", kind: "tool", state: "none" },
		]);
		expect(task.material).toContain("待修正");
		expect(task.material).toContain("- bad [concept] ⚠️ 验证失败");
		expect(task.material).toContain("- new [tool] ❓ 未验证");
		expect(task.material!.indexOf("待修正")).toBeLessThan(task.material!.indexOf("待验证"));
	});

	it("验证任务：提示词不复述手册步骤（修正步骤与矛盾检查归 verify.md）", () => {
		const task = verifyTask([{ id: "bad", kind: "concept", state: "failed" }]);
		expect(task.instructions).not.toContain("修正步骤");
		expect(task.instructions).not.toContain("矛盾");
	});

	it("query 任务不读手册，带检索词与预计算门控索引", () => {
		const q = queryTask("pi", [{ id: "pi", kind: "tool", state: "passed", path: "/x/pi.md" }]);
		expect(q.formats).toEqual([]);
		expect(q.manuals).toEqual([]);
		expect(q.material).toContain("检索词：pi");
		expect(q.material).toContain("- pi [tool] ✅ 已验证 — /x/pi.md");
	});
});

describe("主会话提示词组装", () => {
	it("含手册引用、库根与素材，不含轮数约束", () => {
		const prompt = buildAgentPrompt(verifyTask([{ id: "x", kind: "concept", state: "none" }]), "/p/protocol", "/w");
		expect(prompt).toContain(join("/p/protocol", "verify.md"));
		expect(prompt).toContain(memoryDir("/w"));
		expect(prompt).toContain("- x [concept] ❓ 未验证");
		expect(prompt).not.toContain("最多");
	});

	it("库根尊重 MEMORY_DIR 覆盖（手册只写“库根”，具体路径由提示词供给）", () => {
		process.env.MEMORY_DIR = "/custom/memory";
		try {
			const prompt = buildAgentPrompt(recordTask(), "/p/protocol", "/w");
			expect(prompt).toContain("/custom/memory");
			expect(prompt).not.toContain("/w/.memory");
		} finally {
			delete process.env.MEMORY_DIR;
		}
	});

	it("库根未注入时回到进程目录（补全等早触发路径的防御）", () => {
		expect(buildAgentPrompt(recordTask(), "/p/protocol", undefined)).toContain(memoryDir(undefined));
	});
});
