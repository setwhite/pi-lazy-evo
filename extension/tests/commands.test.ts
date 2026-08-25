/**
 * commands 层单元测试：每个用例独立会话（临时库 + pi 桩 + 注册表），
 * 用例间零状态共享、顺序无关。
 * 覆盖：单入口注册与子命令路由、帮助面板、overview 空库提示、
 * record/query/verify 注入、verify 待验清单计算、mode 查看/切换、提示词构建。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "../commands/index.ts";
import { recordTask, queryTask, verifyTask } from "../prompts/tasks.ts";
import { buildAgentPrompt } from "../prompts/build.ts";
import { appendVerification, writeEntity } from "../core/store.ts";
import { Runtime } from "../index.ts";

/** 命令定义（与 pi 的注册结构对齐） */
interface CommandDef {
	description: string;
	handler: (args: string, ctx: { cwd: string; ui: { notify: (text: string) => void } }) => void | Promise<void>;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
}

/** 隔离会话：独立临时库 + 独立桩 + 独立注册 */
interface Session {
	cwd: string;
	runtime: Runtime;
	names: string[];
	notified: string[];
	sent: string[];
	/** 以 /memory 入口执行一次命令，args 为完整参数（含子命令词） */
	run(args: string): Promise<void>;
	/** 查询子命令补全候选 */
	complete(prefix: string): { value: string; label: string; description?: string }[] | null;
}

/** 用例结束后还原 MEMORY_DIR，避免泄漏到其他测试文件（bun:test 单进程运行） */
afterEach(() => {
	delete process.env.MEMORY_DIR;
});

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
		run: async (args) => {
			await commands.get("memory")!.handler(args, { cwd, ui: { notify: (t) => notified.push(t) } });
		},
		complete: (prefix) => commands.get("memory")!.getArgumentCompletions?.(prefix) ?? null,
	};
}

describe("命令注册", () => {
	it("只注册一个 memory 入口命令", () => {
		const s = createSession();
		expect(s.names).toEqual(["memory"]);
	});

	it("子命令补全：空前缀列全部，前缀过滤，无匹配返回 null", () => {
		const s = createSession();
		expect(s.complete("")).toHaveLength(6);
		expect(s.complete("over")!.map((i) => i.value)).toEqual(["overview"]);
		expect(s.complete("re")!.map((i) => i.value)).toEqual(["record"]);
		expect(s.complete("zzz")).toBeNull();
	});

	it("参数补全：子命令词完整后给参数候选（value 带完整参数串）", () => {
		const s = createSession();
		expect(s.complete("mode")!.map((i) => i.value)).toEqual(["mode auto", "mode manual"]);
		expect(s.complete("mode au")!.map((i) => i.value)).toEqual(["mode auto"]);
		expect(s.complete("mode zz")).toBeNull();
		expect(s.complete("verify")).toBeNull(); // 无参数候选的子命令不再自荐
	});

	it("verify 参数补全：动态列出库中实体 id", () => {
		const s = createSession();
		s.runtime.cwd = s.cwd; // 模拟 session_start 捕获工作目录
		writeEntity(s.cwd, { id: "alpha", kind: "tool", sources: "x", assertions: ["A."] });
		writeEntity(s.cwd, { id: "小小吸血姬", kind: "concept", sources: "x", assertions: ["B."] });
		expect(s.complete("verify")!.map((i) => i.value)).toEqual(["verify alpha", "verify 小小吸血姬"]);
		expect(s.complete("verify 小小")!.map((i) => i.value)).toEqual(["verify 小小吸血姬"]);
		expect(s.complete("verify zz")).toBeNull();
	});

	it("verify 参数补全：对话中新增实体后下次补全可见（无缓存）", () => {
		const s = createSession();
		s.runtime.cwd = s.cwd;
		expect(s.complete("verify")).toBeNull(); // 空库无候选
		writeEntity(s.cwd, { id: "new-entity", kind: "concept", sources: "x", assertions: ["A."] });
		expect(s.complete("verify")!.map((i) => i.value)).toEqual(["verify new-entity"]);
	});
});

describe("/memory 路由", () => {
	it("裸 /memory 显示帮助而非总览", async () => {
		const s = createSession();
		await s.run("");
		expect(s.notified.some((t) => t.includes("Subcommands:"))).toBe(true);
		expect(s.sent).toHaveLength(0);
	});

	it("/memory help 显示帮助", async () => {
		const s = createSession();
		await s.run("help");
		expect(s.notified.some((t) => t.includes("/memory overview"))).toBe(true);
	});

	it("未知子命令提示并回落到帮助", async () => {
		const s = createSession();
		await s.run("banana");
		expect(s.notified.some((t) => t.includes("Unknown subcommand: banana"))).toBe(true);
		expect(s.notified.some((t) => t.includes("Subcommands:"))).toBe(true);
	});
});

describe("/memory overview", () => {
	it("空库时只通知、不注入", async () => {
		const s = createSession();
		await s.run("overview");
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
		expect(s.sent).toHaveLength(0);
	});
});

describe("/memory record / query", () => {
	it("record 注入记录提醒", async () => {
		const s = createSession();
		await s.run("record");
		expect(s.sent.at(-1)!).toContain("[lazy-memory]");
		expect(s.sent.at(-1)!).toContain("长期结论");
	});

	it("record 剩余参数作为附注素材", async () => {
		const s = createSession();
		await s.run("record 记住测试约定");
		expect(s.sent.at(-1)!).toContain("记住测试约定");
	});

	it("query 注入检索词与预计算门控索引", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(s.cwd, { entityId: "test-tool", validator: "test", result: "passed", body: "e" });
		await s.run("query pi plugin");
		const sent = s.sent.at(-1)!;
		expect(sent).toContain("检索词：pi plugin");
		expect(sent).toContain("- test-tool [tool] ✅ 已验证");
	});

	it("query 空库只通知不注入", async () => {
		const s = createSession();
		await s.run("query pi");
		expect(s.sent).toHaveLength(0);
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
	});
});

describe("/memory verify", () => {
	it("未验证实体进入注入清单", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-idea", kind: "concept", sources: "test", assertions: ["Idea."] });
		await s.run("verify");
		expect(s.sent.at(-1)!).toContain("test-idea");
		expect(s.sent.at(-1)!).toContain("待验证实体");
	});

	it("已通过验证的实体不进入默认清单；指定 id 时则复验", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(s.cwd, { entityId: "test-tool", validator: "test", result: "passed", body: "e" });
		await s.run("verify");
		expect(s.sent).toHaveLength(0); // 已验证实体不进入默认清单（无注入）
		await s.run("verify test-tool");
		expect(s.sent.at(-1)!).toContain("test-tool");
	});

	it("全部已验证时只通知、不注入", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "test-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		appendVerification(s.cwd, { entityId: "test-tool", validator: "test", result: "passed", body: "e" });
		await s.run("verify");
		expect(s.sent).toHaveLength(0);
		expect(s.notified.some((t) => t.includes("No entity needs verification."))).toBe(true);
	});

	it("指定不存在的 id 时提示 Entity not found", async () => {
		const s = createSession();
		writeEntity(s.cwd, { id: "real-tool", kind: "tool", sources: "test", assertions: ["Tool."] });
		await s.run("verify ghost");
		expect(s.notified.some((t) => t.includes("Entity not found: ghost"))).toBe(true);
	});

	it("空库时提示库为空而非实体不存在", async () => {
		const s = createSession();
		await s.run("verify ghost");
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
	});
});

describe("/memory mode", () => {
	it("切换挡位并写入 settings.json", async () => {
		const s = createSession();
		await s.run("mode auto");
		expect(s.notified.some((t) => t.includes("Mode switched to auto"))).toBe(true);
		expect(s.notified.some((t) => t.includes("commands + background record & verify"))).toBe(true);
		await s.run("mode");
		expect(s.notified.some((t) => t.includes("auto"))).toBe(true);
	});

	it("非法参数提示用法", async () => {
		const s = createSession();
		await s.run("mode turbo");
		expect(s.notified.some((t) => t.includes("Usage: /memory mode [auto|manual]"))).toBe(true);
	});
});

describe("动作与提示词", () => {
	it("主会话注入经 runtime 派发协议手册指引", () => {
		const s = createSession();
		s.runtime.dispatch(buildAgentPrompt(recordTask(), s.runtime.protocolDir));
		expect(s.sent.at(-1)!).toContain(s.runtime.protocolDir);
	});

	it("record/verify 引用各自手册；query 不读手册、带预计算门控索引", () => {
		const record = recordTask();
		expect(record.formats).toEqual(["entities.md"]);
		expect(record.manuals).not.toContain("verify.md");
		const v = verifyTask([{ id: "pi", kind: "tool", state: "none" }]);
		expect(v.material).toContain("- pi [tool] ❓ 未验证");
		const q = queryTask("pi", [{ id: "pi", kind: "tool", state: "passed", path: "/x/pi.md" }]);
		expect(q.formats).toEqual([]);
		expect(q.manuals).toEqual([]);
		expect(q.material).toContain("检索词：pi");
		expect(q.material).toContain("- pi [tool] ✅ 已验证 — /x/pi.md");
	});
});