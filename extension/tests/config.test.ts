/**
 * config 层单元测试：独立临时 cwd，避免污染真实 settings.json。
 * 覆盖：默认挡位、写入往返、只改命名空间保留其余内容。
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setMode } from "../core/config.ts";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "lazy-memory-config-"));
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

describe("setMode", () => {
	it("只改 lazy-memory 命名空间，保留文件其余内容", () => {
		const path = join(cwd, ".pi", "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "dark", other: 1 }, null, 2) + "\n");
		expect(setMode(cwd, "auto")).toBe(true);
		const data = JSON.parse(readFileSync(path, "utf8")) as { theme: string; other: number; "lazy-memory": { mode: string } };
		expect(data.theme).toBe("dark");
		expect(data.other).toBe(1);
		expect(data["lazy-memory"].mode).toBe("auto");
	});

	it("settings.json 缺失时按空对象创建", () => {
		expect(setMode(cwd, "auto")).toBe(true);
		expect(loadConfig(cwd).mode).toBe("auto");
	});
});