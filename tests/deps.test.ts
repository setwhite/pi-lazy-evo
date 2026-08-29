/**
 * 依赖失效域单元测试：gatedLibrary = 读库 + 门控 + depends-on 纯推导覆盖。
 * 用 utimes 拨 mtime / 显式 checked_at 控制先后关系，避免 sleep。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatedLibrary } from "../extension/deps.ts";
import { appendVerification, ensureMemoryDir } from "../extension/store.ts";

let cwd: string;
let mem: string;
/** 真实依赖文件（相对 cwd） */
const DEP_FILE = "src/impl.ts";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-deps-"));
	mem = join(cwd, ".memory");
	process.env.MEMORY_DIR = mem;
	ensureMemoryDir(cwd);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, DEP_FILE), "v1", "utf8");
});

afterEach(() => {
	delete process.env.MEMORY_DIR;
});

/** 写一个带 depends-on 的实体文件（writeEntity 不写 depends-on，直接落盘） */
function writeEntityFile(id: string, dependsOn: string[]): void {
	const fm = `---\nid: ${id}\nkind: concept\nsources: test\n${dependsOn.length ? `depends-on: ${dependsOn.join(", ")}\n` : ""}---\n\nA1: 断言。\n`;
	writeFileSync(join(mem, "entities", `${id}.md`), fm, "utf8");
}

/** 把依赖文件 mtime 拨到偏移毫秒（正数=未来，模拟验证后代码演进；负数=过去） */
function touchDep(offsetMs: number): void {
	const when = new Date(Date.now() + offsetMs);
	utimesSync(join(cwd, DEP_FILE), when, when);
}

/** 追加一条 checked_at 相对现在偏移 offsetMs 的 passed 记录（模拟"验证发生在依赖变化之后"） */
function passRecord(entityId: string, offsetMs = 0): void {
	const checkedAt = new Date(Date.now() + offsetMs).toISOString();
	appendVerification(cwd, { entityId, validator: "code", result: "passed", body: "v", checkedAt });
}

function stateOf(id: string): string {
	return gatedLibrary(cwd).find((g) => g.meta.id === id)!.gate.state;
}

describe("gatedLibrary 依赖失效推导", () => {
	it("passed 之后依赖文件被改 → stale", () => {
		writeEntityFile("e1", [DEP_FILE]);
		passRecord("e1");
		expect(stateOf("e1")).toBe("passed");
		touchDep(+5_000); // 修改发生在验证之后
		expect(stateOf("e1")).toBe("stale");
	});

	it("依赖修改早于最新 passed 记录 → 保持 passed（纯推导自愈，无需基线刷新）", () => {
		writeEntityFile("e1", [DEP_FILE]);
		touchDep(-5_000);
		passRecord("e1");
		expect(stateOf("e1")).toBe("passed");
	});

	it("stale 后复验通过 → 回到 passed", () => {
		writeEntityFile("e1", [DEP_FILE]);
		passRecord("e1");
		touchDep(+5_000);
		expect(stateOf("e1")).toBe("stale");
		passRecord("e1", +10_000); // 复验发生在依赖修改之后
		expect(stateOf("e1")).toBe("passed");
	});

	it("非 passed 态不受依赖影响（本就在待办队列）", () => {
		writeEntityFile("e1", [DEP_FILE]);
		touchDep(+5_000);
		expect(stateOf("e1")).toBe("none"); // 未验证：不进依赖判定
	});

	it("依赖文件缺失（重构期路径变化）不置 stale", () => {
		writeEntityFile("e1", ["src/gone.ts"]);
		passRecord("e1");
		expect(stateOf("e1")).toBe("passed");
	});

	it("无 depends-on 的实体不受依赖扫描影响", () => {
		writeEntityFile("e1", []);
		passRecord("e1");
		touchDep(+5_000);
		expect(stateOf("e1")).toBe("passed");
	});
});
