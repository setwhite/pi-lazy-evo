/**
 * config 层单元测试：$PI_GLOBAL_SETTINGS_FILE 指向临时 home，独立临时 cwd，避免污染真实 settings.json。
 * 覆盖：默认挡位、mode 全局往返、全局目录自动创建、项目 mode 不覆盖全局、
 * 项目字段覆盖全局字段、只改命名空间保留其余内容。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setMode } from "../extension/config.ts";

/** 全局 settings 环境变量名（与 config.ts 的注入点同名） */
const GLOBAL_SETTINGS_ENV = "PI_GLOBAL_SETTINGS_FILE";

let homeDir: string;
let cwd: string;

/** 临时 home 下的全局 settings.json 路径 */
const globalFile = (): string => join(homeDir, ".pi", "agent", "settings.json");

/** 项目 settings.json 路径 */
const projectFile = (): string => join(cwd, ".pi", "settings.json");

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "pi-lazy-evo-home-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-config-"));
	process.env[GLOBAL_SETTINGS_ENV] = globalFile();
});

afterEach(() => {
	delete process.env[GLOBAL_SETTINGS_ENV];
});

describe("loadConfig", () => {
	it("无配置时默认 manual", () => {
		expect(loadConfig(cwd).mode).toBe("manual");
	});
});

describe("mode（全局）", () => {
	it("setMode 写入全局后按写入值读取（往返）", () => {
		expect(setMode("auto")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("auto");
		expect(setMode("manual")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("manual");
	});

	it("全局目录不存在时自动创建并写入", () => {
		expect(setMode("auto")).toBe(true);
		const data = JSON.parse(readFileSync(globalFile(), "utf8")) as { "pi-lazy-evo": { mode: string } };
		expect(data["pi-lazy-evo"].mode).toBe("auto");
	});

	it("只改 pi-lazy-evo 命名空间，保留文件其余内容", () => {
		const path = globalFile();
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(path, JSON.stringify({ theme: "dark", other: 1 }, null, 2) + "\n");
		expect(setMode("auto")).toBe(true);
		const data = JSON.parse(readFileSync(path, "utf8")) as { theme: string; other: number; "pi-lazy-evo": { mode: string } };
		expect(data.theme).toBe("dark");
		expect(data.other).toBe(1);
		expect(data["pi-lazy-evo"].mode).toBe("auto");
	});

	it("项目 settings 的 mode 不覆盖全局（mode 只从全局取）", () => {
		expect(setMode("auto")).toBe(true);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ "pi-lazy-evo": { mode: "manual" } }, null, 2) + "\n");
		expect(loadConfig(cwd).mode).toBe("auto");
	});
});

describe("loadConfig auto 配置", () => {
	const settings = (ns: unknown) => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ "pi-lazy-evo": ns }, null, 2) + "\n");
	};

	it("无配置时使用默认阈值与轮数上限", () => {
		const config = loadConfig(cwd);
		expect(config.autoWatermarkTokens).toBe(32_000);
		expect(config.autoMaxTurns).toBe(16);
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
		expect(config.autoWatermarkTokens).toBe(32_000);
		expect(config.autoMaxTurns).toBe(16);
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