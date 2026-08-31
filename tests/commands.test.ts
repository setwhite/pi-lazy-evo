/**
 * commands 层单元测试：每个用例独立会话（临时库 + pi 桩 + 注册表），
 * 用例间零状态共享、顺序无关。
 * 覆盖：单入口注册与子命令路由、帮助面板、补全两级、overview 计数与待办清单、
 * record（附注注入 / 无附注不重复喂转录）、query 索引注入、verify 清单计算与不默认全量。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "../extension/commands.ts";
import { buildAgentPrompt, queryTask, recordTask, verifyTask } from "../extension/prompts.ts";
import { Runtime } from "../extension/index.ts";
import { writeEntityFile, writeRecordFile } from "./helpers.ts";

/** 会话条目桩（结构兼容 TranscriptEntry） */
interface EntryStub {
	type: string;
	message?: { role?: string; content?: unknown };
}

/** 命令 ctx 桩：只实现 commands.ts 实际用到的三处 */
interface CtxStub {
	cwd: string;
	ui: { notify: (text: string) => void };
	sessionManager: { getEntries: () => EntryStub[] };
}

/** 命令定义（与 pi 的注册结构对齐） */
interface CommandDef {
	description: string;
	handler: (args: string, ctx: CtxStub) => void | Promise<void>;
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

/** 组装隔离会话（每用例一个新会话，无共享状态）；entries 供 record 无附注时取转录 */
function createSession(entries: EntryStub[] = []): Session {
	const cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-commands-"));
	process.env.MEMORY_DIR = join(cwd, ".memory");
	const notified: string[] = [];
	const sent: string[] = [];
	const commands = new Map<string, CommandDef>();
	const pi = {
		registerCommand: (name: string, def: CommandDef) => void commands.set(name, def),
		sendUserMessage: async (content: string) => void sent.push(content),
	} as unknown as ExtensionAPI;
	const runtime = new Runtime(pi);
	runtime.cwd = cwd; // 模拟 session_start 捕获工作目录
	registerMemoryCommands(pi, runtime);
	return {
		cwd,
		runtime,
		names: [...commands.keys()].sort(),
		notified,
		sent,
		run: async (args) => {
			const ctx = { cwd, ui: { notify: (t: string) => notified.push(t) }, sessionManager: { getEntries: () => entries } } satisfies CtxStub;
			await commands.get("memory")!.handler(args, ctx);
		},
		complete: (prefix) => commands.get("memory")!.getArgumentCompletions?.(prefix) ?? null,
	};
}

describe("命令注册", () => {
	it("只注册一个 memory 入口命令", () => {
		expect(createSession().names).toEqual(["memory"]);
	});

	it("子命令补全：空前缀列全部，前缀过滤，无匹配返回 null", () => {
		const s = createSession();
		expect(s.complete("")).toHaveLength(5);
		expect(s.complete("over")!.map((i) => i.value)).toEqual(["overview"]);
		expect(s.complete("re")!.map((i) => i.value)).toEqual(["record"]);
		expect(s.complete("zzz")).toBeNull();
	});

	it("verify 参数补全：all 居首 + 动态列实体 id", () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "alpha" });
		writeEntityFile(s.cwd, { id: "小小吸血姬", body: ["A1: 断言。"] });
		expect(s.complete("verify")!.map((i) => i.value)).toEqual(["verify all", "verify alpha", "verify 小小吸血姬"]);
		expect(s.complete("verify 小小")!.map((i) => i.value)).toEqual(["verify 小小吸血姬"]);
		expect(s.complete("verify zz")).toBeNull();
	});

	it("verify 参数补全：空库也有 all；新增实体后下次补全可见（无缓存）", () => {
		const s = createSession();
		expect(s.complete("verify")!.map((i) => i.value)).toEqual(["verify all"]);
		writeEntityFile(s.cwd, { id: "new-entity" });
		expect(s.complete("verify")!.map((i) => i.value)).toEqual(["verify all", "verify new-entity"]);
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

	it("四态计数 + 待修正排在待验证之前", async () => {
		const s = createSession();
		const now = new Date().toISOString();
		writeEntityFile(s.cwd, { id: "ok", kind: "tool" });
		writeRecordFile(s.cwd, { entityId: "ok", checkedAt: now, result: "passed" });
		writeEntityFile(s.cwd, { id: "broken", kind: "concept" });
		writeRecordFile(s.cwd, { entityId: "broken", checkedAt: now, result: "failed" });
		writeEntityFile(s.cwd, { id: "fresh" });
		await s.run("overview");
		const notice = s.notified.at(-1)!;
		expect(notice).toContain("Entities 3 | passed 1 / failed 1 / unverified 1 / stale 0");
		expect(notice).toContain("Needs fix (1): broken");
		expect(notice).toContain("Needs verification (1): fresh");
		expect(notice.indexOf("Needs fix")).toBeLessThan(notice.indexOf("Needs verification"));
	});

	it("全库已验证时不输出待办行", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "ok", kind: "tool" });
		writeRecordFile(s.cwd, { entityId: "ok", checkedAt: new Date().toISOString(), result: "passed" });
		await s.run("overview");
		expect(s.notified.at(-1)).not.toContain("Needs");
	});
});

describe("/memory record", () => {
	it("带附注时用附注作素材", async () => {
		const s = createSession();
		await s.run("record 记住测试约定");
		expect(s.sent.at(-1)!).toContain("[pi-lazy-evo]");
		expect(s.sent.at(-1)!).toContain("记住测试约定");
	});

	it("无附注时不注入转录——素材即代理当前会话，不得重复喂入", async () => {
		const s = createSession([{ type: "message", message: { role: "user", content: "刚刚讨论出的结论" } }]);
		await s.run("record");
		const sent = s.sent.at(-1)!;
		expect(sent).not.toContain("刚刚讨论出的结论");
		expect(sent).not.toContain("用户附注");
	});

	it("无附注时仍派发任务，提示代理从本次会话沉淀", async () => {
		const s = createSession();
		await s.run("record");
		expect(s.sent.at(-1)!).toContain("按手册把本次会话中值得沉淀的结论写入库");
	});
});

describe("/memory query", () => {
	it("注入检索词与预计算门控索引", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "test-tool", kind: "tool", sources: "test" });
		writeRecordFile(s.cwd, { entityId: "test-tool", checkedAt: new Date().toISOString(), result: "passed" });
		await s.run("query pi plugin");
		const sent = s.sent.at(-1)!;
		expect(sent).toContain("检索词：pi plugin");
		expect(sent).toContain("- test-tool [tool] ✅ 已验证");
	});

	it("空库只通知不注入", async () => {
		const s = createSession();
		await s.run("query pi");
		expect(s.sent).toHaveLength(0);
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
	});
});

describe("/memory verify", () => {
	it("verify all：全库待验实体进入注入清单", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "test-idea", body: ["A1: 想法。"] });
		await s.run("verify all");
		expect(s.sent.at(-1)!).toContain("test-idea");
		expect(s.sent.at(-1)!).toContain("待验证");
	});

	it("裸 verify 不默认全量：展示用法与待办摘要，不注入", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "test-idea" });
		await s.run("verify");
		expect(s.sent).toHaveLength(0);
		const notice = s.notified.at(-1)!;
		expect(notice).toContain("Usage: /memory verify all");
		expect(notice).toContain("Needs verification (1): test-idea");
	});

	it("裸 verify 待办为空时明确说明", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "ok", kind: "tool" });
		writeRecordFile(s.cwd, { entityId: "ok", checkedAt: new Date().toISOString(), result: "passed" });
		await s.run("verify");
		expect(s.notified.at(-1)).toContain("Queue is empty");
	});

	it("已通过验证的实体不进 all 清单；指定 id 时则复验", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "test-tool", kind: "tool" });
		writeRecordFile(s.cwd, { entityId: "test-tool", checkedAt: new Date().toISOString(), result: "passed" });
		await s.run("verify all");
		expect(s.sent).toHaveLength(0); // 已验证实体不进入默认清单（无注入）
		expect(s.notified.some((t) => t.includes("No entity needs verification."))).toBe(true);
		await s.run("verify test-tool");
		expect(s.sent.at(-1)!).toContain("test-tool");
	});

	it("指定不存在的 id 时提示 Entity not found", async () => {
		const s = createSession();
		writeEntityFile(s.cwd, { id: "real-tool", kind: "tool" });
		await s.run("verify ghost");
		expect(s.notified.some((t) => t.includes("Entity not found: ghost"))).toBe(true);
	});

	it("空库时提示库为空而非实体不存在", async () => {
		const s = createSession();
		await s.run("verify ghost");
		expect(s.notified.some((t) => t.includes("Memory library is empty."))).toBe(true);
	});
});

describe("注入通道", () => {
	it("主会话注入经 runtime 派发协议手册指引", () => {
		const s = createSession();
		s.runtime.dispatch(buildAgentPrompt(recordTask(), s.runtime.protocolDir, s.runtime.cwd));
		expect(s.sent.at(-1)!).toContain(s.runtime.protocolDir);
	});

	it("任务纯数据：record 只读实体面，verify 读两面，query 不读手册", () => {
		expect(recordTask().formats).toEqual(["entities.md"]);
		expect(verifyTask([{ id: "pi", kind: "tool", state: "none" }]).manuals).toEqual(["verify.md"]);
		const q = queryTask("pi", [{ id: "pi", kind: "tool", state: "passed", path: "/x/pi.md" }]);
		expect(q.formats).toEqual([]);
		expect(q.manuals).toEqual([]);
	});
});
