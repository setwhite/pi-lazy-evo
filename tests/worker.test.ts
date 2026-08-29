/**
 * worker 子进程通道单元测试：参数组装 / 事件流活动描述 / 活动面板行管理。
 * 不真正 spawn pi 子进程（spawn 行为由集成验证）。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityPanel, buildWorkerArgs, WorkerFeed } from "../extension/worker.ts";

/** 收集本次用例生成的临时目录，统一清理 */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withCleanup<T extends { promptDir: string }>(built: T): T {
	tempDirs.push(built.promptDir);
	return built;
}

describe("buildWorkerArgs", () => {
	it("事件流通道：--mode json + --no-session，不再用 -p", () => {
		const built = withCleanup(buildWorkerArgs({ tools: ["read"], promptContent: "P" }));
		expect(built.args).toContain("--mode");
		expect(built.args[built.args.indexOf("--mode") + 1]).toBe("json");
		expect(built.args).toContain("--no-session");
		expect(built.args).not.toContain("-p");
		expect(built.args).not.toContain("--model");
		expect(built.args).toContain("--thinking");
	});

	it("配置了便宜模型：--model provider/id 与 thinking 档位", () => {
		const built = withCleanup(buildWorkerArgs({ model: { provider: "openrouter", id: "a-model", thinking: "low" }, tools: ["read", "bash"], promptContent: "P" }));
		expect(built.args).toContain("openrouter/a-model");
		expect(built.args).toContain("--thinking");
		expect(built.args).toContain("--append-system-prompt");
	});

	it("提示词文件落盘且工具白名单逗号拼接", () => {
		const built = withCleanup(buildWorkerArgs({ tools: ["read", "grep", "web_search"], promptContent: "内容" }));
		expect(readFileSync(built.promptFile, "utf8")).toBe("内容");
		expect(existsSync(built.promptFile)).toBe(true);
		const idx = built.args.indexOf("--tools");
		expect(built.args[idx + 1]).toBe("read,grep,web_search");
	});
});

describe("WorkerFeed", () => {
	const json = (obj: Record<string, unknown>) => JSON.stringify(obj);

	it("turn_start 计数进轮次并返回活动文本", () => {
		const feed = new WorkerFeed();
		expect(feed.consume(json({ type: "turn_start" }))).toContain("第 1 轮");
		expect(feed.consume(json({ type: "turn_start" }))).toContain("第 2 轮");
	});

	it("tool_execution_start 显示工具名与关键参数", () => {
		const feed = new WorkerFeed();
		const text = feed.consume(json({ type: "tool_execution_start", toolName: "read", args: { file_path: "/long/path/to/entities/foo.md" } }));
		expect(text).toContain("read");
		expect(text).toContain("entities/foo.md"); // 长路径只留末两段
	});

	it("bash 命令压平空白并截断", () => {
		const feed = new WorkerFeed();
		const text = feed.consume(json({ type: "tool_execution_start", toolName: "bash", args: { command: "grep -rn  " + "x".repeat(100) } }));
		expect(text).toContain("grep -rn x");
		expect(text!.length).toBeLessThan(80);
	});

	it("无关事件与非 JSON 行返回 null，状态不变", () => {
		const feed = new WorkerFeed();
		expect(feed.consume("")).toBeNull();
		expect(feed.consume("not json")).toBeNull();
		expect(feed.consume(json({ type: "session", version: 3 }))).toBeNull();
		expect(feed.consume(json({ type: "message_end", message: { role: "assistant" } }))).toBeNull();
	});

	it("文本无变化时不重复推送", () => {
		const feed = new WorkerFeed();
		const line = json({ type: "tool_execution_start", toolName: "ls", args: {} });
		expect(feed.consume(line)).not.toBeNull();
		expect(feed.consume(line)).toBeNull(); // 同一活动不重复渲染
	});
});

describe("ActivityPanel", () => {
	/** 收集每次渲染收到的行快照 */
	function collectingPanel(): { panel: ActivityPanel; frames: (string[] | undefined)[] } {
		const frames: (string[] | undefined)[] = [];
		return { panel: new ActivityPanel((lines) => frames.push(lines)), frames };
	}

	it("set 按行渲染（含行 id），drop 后空集合渲染 undefined 清除", () => {
		const { panel, frames } = collectingPanel();
		panel.set("record", "第 1 轮 · read");
		expect(frames.at(-1)).toEqual(["record 第 1 轮 · read"]);
		panel.set("verify#2", "第 3 轮 · grep");
		expect(frames.at(-1)!.length).toBe(2); // 行序 = 插入序
		panel.drop("record");
		expect(frames.at(-1)).toEqual(["verify#2 第 3 轮 · grep"]);
		panel.drop("verify#2");
		expect(frames.at(-1)).toBeUndefined(); // 全部结束 → 清除面板
	});

	it("未知行 id 的 drop 不触发渲染", () => {
		const { panel, frames } = collectingPanel();
		panel.drop("ghost");
		expect(frames).toEqual([]);
	});
});
