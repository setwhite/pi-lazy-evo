/**
 * config 层单元测试：独立临时 cwd，避免污染真实 settings.json。
 * 覆盖：默认挡位、写入往返、只改命名空间保留其余内容。
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setMode } from "../config.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-config-"));
	// setMode 写入项目 .pi/settings.json，父目录需先存在
	mkdirSync(join(cwd, ".pi"), { recursive: true });
});

describe("loadConfig", () => {
	it("无配置时默认 manual", () => {
		expect(loadConfig(cwd).mode).toBe("manual");
	});

	it("setMode 写入后按写入值读取（往返）", () => {
		expect(setMode(cwd, "auto")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("auto");
		expect(setMode(cwd, "manual")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("manual");
	});
});

describe("loadConfig auto 配置", () => {
	const settings = (ns: unknown) => writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-lazy-evo": ns }, null, 2) + "\n");

	it("无配置时使用默认阈值与轮数上限", () => {
		const config = loadConfig(cwd);
		expect(config.autoWatermarkTokens).toBe(64_000);
		expect(config.autoMaxTurns).toBe(12);
		expect(config.autoModel).toBeUndefined();
		expect(config.autoMemoTools).toEqual(["read", "grep", "ls", "bash", "write", "edit"]);
		expect(config.autoVerifyTools).toEqual(["read", "grep", "ls", "bash", "write", "edit", "web_search", "web_fetch"]);
	});

	it("可配置阈值、轮数与便宜模型", () => {
		settings({ autoWatermarkTokens: 8000, autoMaxTurns: 8, autoModel: { provider: "openrouter", id: "a-cheap-model", thinking: "low" } });
		const config = loadConfig(cwd);
		expect(config.autoWatermarkTokens).toBe(8000);
		expect(config.autoMaxTurns).toBe(8);
		expect(config.autoModel).toEqual({ provider: "openrouter", id: "a-cheap-model", thinking: "low" });
	});

	it("非法阈值类型/非正数被忽略回默认", () => {
		settings({ autoWatermarkTokens: "8000", autoMaxTurns: -1 });
		const config = loadConfig(cwd);
		expect(config.autoWatermarkTokens).toBe(64_000);
		expect(config.autoMaxTurns).toBe(12);
	});

	it("autoModel 缺 provider 或 id 被忽略（回退主模型）", () => {
		settings({ autoModel: { provider: "openrouter" } });
		expect(loadConfig(cwd).autoModel).toBeUndefined();
		settings({ autoModel: "fast" });
		expect(loadConfig(cwd).autoModel).toBeUndefined();
	});

	it("可覆盖 worker 工具白名单：解析去重且非法值回默认", () => {
		settings({ autoMemoTools: ["read", "bash", "read"], autoVerifyTools: "nope" });
		const config = loadConfig(cwd);
		expect(config.autoMemoTools).toEqual(["read", "bash"]);
		expect(config.autoVerifyTools).toEqual(["read", "grep", "ls", "bash", "write", "edit", "web_search", "web_fetch"]);
		settings({ autoMemoTools: [1, "", "write", "grep", "grep", "write"] });
		expect(loadConfig(cwd).autoMemoTools).toEqual(["write", "grep"]);
	});
});

describe("setMode", () => {
	it("只改 pi-lazy-evo 命名空间，保留文件其余内容", () => {
		const path = join(cwd, ".pi", "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "dark", other: 1 }, null, 2) + "\n");
		expect(setMode(cwd, "auto")).toBe(true);
		const data = JSON.parse(readFileSync(path, "utf8")) as { theme: string; other: number; "pi-lazy-evo": { mode: string } };
		expect(data.theme).toBe("dark");
		expect(data.other).toBe(1);
		expect(data["pi-lazy-evo"].mode).toBe("auto");
	});

	it("settings.json 缺失时按空对象创建", () => {
		expect(setMode(cwd, "auto")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("auto");
	});
});