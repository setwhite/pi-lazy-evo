/**
 * commands 层单元测试：每个用例独立会话（临时库 + pi 桩 + 注册表），
 * 用例间零状态共享、顺序无关。
 * 覆盖：5 命令注册、overview 空库提示、record/query/verify 注入、
 * verify 待验清单计算、mode 查看/切换、提示词构建。
 */
import { describe, expect, it } from "bun:test";
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

/** 隔离会话：独立临时库 + 独立桩 + 独立注册 */
interface Session {
	cwd: string;
	runtime: Runtime;
	names: string[];
	notified: string[];
	sent: string[];
	run(name: string, args: string): Promise<void>;
}

/** 组装隔离会话（每用例一个新会话，无共享状态） */
function createSession(): Session {
	const cwd = mkdtempSync(join(tmpdir(), "lazy-memory-commands-"));
	process.env.MEMORY_DIR = join(cwd, ".memory");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const notified: string[] = [];
	const sent: string[] = [];
	const commands = new Map<string, CommandDef>();
	const pi = {
		registerCommand: (name: string, def: CommandDef) => void commands.set(name, def),
		sendUserMessage: async (content: string) => void sent.push(content),
	} as unknown as ExtensionAPI;
	const runtime = new Runtime(pi);
	registerMemoryCommands(pi, runtime);
	return {
		cwd,
		runtime,
		names: [...commands.keys()].sort(),
		notified,
		sent,
		run: async (name, args) => {
			await commands.get(name)!.handler(args, { cwd, ui: { notify: (t) => notified.push(t) } });
		},
	};
}

describe("命令注册", () => {
	it("注册全部 5 个命令", () => {
		const s = createSession();
		expect(s.names).toEqual(["memory", "memory mode", "memory query", "memory record", "memory verify"]);
	});
});

describe("/memory overview", () => {
	it("空库时只通知、不注入", async () => {
		const s = createSession();
		await s.run("memory", "");
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
		expect(s.sent).toHaveLength(0);
	});
});

describe("/memory record / query", () => {
	it("record 注入沉淀提醒", async () => {
		const s = createSession();
		await s.run("memory record", "");
		expect(s.sent.at(-1)!).toContain("[lazy-memory]");
		expect(s.sent.at(-1)!).toContain("settlement");
	});

	it("query 注入带检索词的提醒", async () => {
		const s = createSession();
		await s.run("memory query", "pi plugin");
		expect(s.sent.at(-1)!).toContain("Search terms: pi plugin");
	});
});

describe("/memory verify", () => {
	it("未验证实体进入注入清单", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-idea", kind: "concept", sources: "test", assertions: ["Idea."] });
		await s.run("memory verify", "");
		expect(s.sent.at(-1)!).toContain("test-idea");
		expect(s.sent.at(-1)!).toContain("Manual verification requested");
	});

	it("已通过验证的实体不进入默认清单；指定 id 时则复验", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(s.cwd, { entityId: "test-tool", validator: "test", result: "passed", evidence: "e" });
		await s.run("memory verify", "");
		expect(s.sent).toHaveLength(0); // 已验证实体不进入默认清单（无注入）
		await s.run("memory verify", "test-tool");
		expect(s.sent.at(-1)!).toContain("test-tool");
	});

	it("全部已验证时只通知、不注入", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(s.cwd, { entityId: "test-tool", validator: "test", result: "passed", evidence: "e" });
		await s.run("memory verify", "");
		expect(s.sent).toHaveLength(0);
		expect(s.notified.some((t) => t.includes("No entity needs verification."))).toBe(true);
	});

	it("指定不存在的 id 时提示 Entity not found", async () => {
		const s = createSession();
		await s.run("memory verify", "ghost");
		expect(s.notified.some((t) => t.includes("Entity not found: ghost"))).toBe(true);
	});
});

describe("/memory mode", () => {
	it("切换挡位并写入 settings.json", async () => {
		const s = createSession();
		await s.run("memory mode", "auto");
		expect(s.notified.some((t) => t.includes("Mode switched to auto."))).toBe(true);
		await s.run("memory mode", "");
		expect(s.notified.some((t) => t.includes("auto"))).toBe(true);
	});

	it("非法参数提示用法", async () => {
		const s = createSession();
		await s.run("memory mode", "turbo");
		expect(s.notified.some((t) => t.includes("Usage: /memory mode [auto|manual]"))).toBe(true);
	});
});

describe("动作与提示词", () => {
	it("SettlerActions 通过 runtime 派发协议手册指引", () => {
		const s = createSession();
		createSettlerActions(s.runtime).query("pi");
		expect(s.sent.at(-1)!).toContain(s.runtime.protocolDir);
	});

	it("createPrompts 构建三条完整指令", () => {
		const s = createSession();
		const prompts = createPrompts(join(s.cwd, "protocol"));
		expect(prompts.record()).toContain("settlement");
		expect(prompts.query("pi")).toContain("Search terms: pi");
		expect(prompts.verify([{ id: "pi", kind: "tool", state: "none" }])).toContain("- pi [tool]");
	});
});