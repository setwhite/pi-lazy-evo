/**
 * commands 层单元测试：pi 桩收集注册与派发，临时 MEMORY_DIR 测真实命令行为。
 * 覆盖：5 命令注册、overview 空库提示、record/query/verify 注入、
 * verify 待验清单计算、mode 查看/切换、提示词构建。
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "../commands/index.ts";
import { createSettlerActions } from "../agents/settler/agent.ts";
import { createPrompts } from "../agents/settler/prompts.ts";
import { appendVerification, writeEntity } from "../store.ts";
import { Runtime } from "../index.ts";

/** 命令定义（与 pi 的注册结构对齐） */
interface CommandDef {
	description: string;
	handler: (args: string, ctx: { cwd: string; ui: { notify: (text: string) => void } }) => void | Promise<void>;
}

let cwd: string;
const commands = new Map<string, CommandDef>();
const notified: string[] = [];
const sent: string[] = [];
let runtime: Runtime;

beforeAll(() => {
	cwd = mkdtempSync(join(tmpdir(), "lazy-memory-commands-"));
	process.env.MEMORY_DIR = join(cwd, ".memory");
	// mode 命令写入项目 .pi/settings.json，父目录需先存在
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const pi = {
		registerCommand: (name: string, def: CommandDef) => void commands.set(name, def),
		sendUserMessage: async (content: string) => void sent.push(content),
	} as unknown as ExtensionAPI;
	runtime = new Runtime(pi);
	registerMemoryCommands(pi, runtime);
});

describe("命令注册", () => {
	it("注册全部 5 个命令", () => {
		expect([...commands.keys()].sort()).toEqual(["memory", "memory mode", "memory query", "memory record", "memory verify"]);
	});
});

describe("/memory overview", () => {
	it("空库时只通知、不注入", async () => {
		await commands.get("memory")!.handler("", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
		expect(sent).toHaveLength(0);
		notified.length = 0;
	});
});

describe("/memory record / query", () => {
	it("record 注入沉淀提醒", async () => {
		await commands.get("memory record")!.handler("", { cwd, ui: { notify: () => {} } });
		expect(sent.at(-1)!).toContain("[lazy-memory]");
		expect(sent.at(-1)!).toContain("settlement");
	});

	it("query 注入带检索词的提醒", async () => {
		await commands.get("memory query")!.handler("pi plugin", { cwd, ui: { notify: () => {} } });
		expect(sent.at(-1)!).toContain("Search terms: pi plugin");
	});
});

describe("/memory verify", () => {
	it("未验证实体进入注入清单", async () => {
		writeEntity(cwd, { id: "test-idea", kind: "concept", sources: "test", assertions: ["Idea."] });
		await commands.get("memory verify")!.handler("", { cwd, ui: { notify: () => {} } });
		expect(sent.at(-1)!).toContain("test-idea");
		expect(sent.at(-1)!).toContain("Manual verification requested");
	});

	it("已通过验证的实体不进入默认清单；指定 id 时则复验", async () => {
		writeEntity(cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(cwd, { entityId: "test-tool", validator: "test", result: "passed", evidence: "e" });
		await commands.get("memory verify")!.handler("", { cwd, ui: { notify: () => {} } });
		expect(sent.at(-1)!).not.toContain("test-tool");
		await commands.get("memory verify")!.handler("test-tool", { cwd, ui: { notify: () => {} } });
		expect(sent.at(-1)!).toContain("test-tool");
	});

	it("全部已验证时只通知、不注入", async () => {
		// 前序用例留下的 test-idea 仍未验证，先补齐使其通过
		appendVerification(cwd, { entityId: "test-idea", validator: "test", result: "passed", evidence: "e" });
		const before = sent.length;
		await commands.get("memory verify")!.handler("", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(sent.length).toBe(before);
		expect(notified.some((t) => t.includes("No entity needs verification."))).toBe(true);
		notified.length = 0;
	});

	it("指定不存在的 id 时提示 Entity not found", async () => {
		await commands.get("memory verify")!.handler("ghost", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(notified.some((t) => t.includes("Entity not found: ghost"))).toBe(true);
		notified.length = 0;
	});
});

describe("/memory mode", () => {
	it("切换挡位并写入 settings.json", async () => {
		await commands.get("memory mode")!.handler("auto", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(notified.some((t) => t.includes("Mode switched to auto."))).toBe(true);
		notified.length = 0;
		await commands.get("memory mode")!.handler("", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(notified.some((t) => t.includes("auto"))).toBe(true);
		notified.length = 0;
	});

	it("非法参数提示用法", async () => {
		await commands.get("memory mode")!.handler("turbo", { cwd, ui: { notify: (t) => notified.push(t) } });
		expect(notified.some((t) => t.includes("Usage: /memory mode [auto|manual]"))).toBe(true);
		notified.length = 0;
	});
});

describe("动作与提示词", () => {
	it("SettlerActions 通过 runtime 派发协议路径指引", () => {
		const actions = createSettlerActions(runtime);
		actions.query("pi");
		expect(sent.at(-1)!).toContain(runtime.protocolPath);
	});

	it("createPrompts 构建三条完整指令", () => {
		const prompts = createPrompts(join(cwd, "PROTOCOL.md"));
		expect(prompts.record()).toContain("settlement");
		expect(prompts.query("pi")).toContain("Search terms: pi");
		expect(prompts.verify([{ id: "pi", kind: "tool", state: "none" }])).toContain("- pi [tool]");
	});
});