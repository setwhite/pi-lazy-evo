/**
 * store 层单元测试：临时 MEMORY_DIR，不触碰真实库。
 * 覆盖：目录骨架、实体读写（来源去重）、验证记录（只追加 + 同日序号）、
 * 整库配对、校验规则、损坏记录丢弃。
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendVerification,
	ensureMemoryDir,
	listVerifications,
	readEntity,
	readLibrary,
	validateId,
	validateKind,
	writeEntity,
} from "../core/store.ts";

let cwd: string;
let mem: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "lazy-memory-store-"));
	mem = join(cwd, ".memory");
	process.env.MEMORY_DIR = mem;
});

describe("ensureMemoryDir", () => {
	it("创建 entities/verifications 骨架", () => {
		ensureMemoryDir(cwd);
		expect(existsSync(join(mem, "entities"))).toBe(true);
		expect(existsSync(join(mem, "verifications"))).toBe(true);
	});
});

describe("writeEntity / readEntity", () => {
	it("新建实体可回读（front-matter 三字段 + 正文断言）", () => {
		const file = writeEntity(cwd, { id: "test-tool", kind: "tool", sources: "smoke test", assertions: ["A statement.", "Another statement."] });
		expect(file.meta.id).toBe("test-tool");
		expect(file.meta.kind).toBe("tool");
		expect(file.body).toBe("A statement.\nAnother statement.");
		const reread = readEntity(cwd, "test-tool")!;
		expect(reread.meta.path).toBe(file.meta.path);
		expect(reread.body).toBe(file.body);
	});

	it("更新实体：新出处分号追加", () => {
		writeEntity(cwd, { id: "t", kind: "tool", sources: "a", assertions: ["X."] });
		writeEntity(cwd, { id: "t", kind: "tool", sources: "b", assertions: ["X.", "Y."] });
		expect(readEntity(cwd, "t")!.meta.sources).toBe("a；b");
	});

	it("更新实体：相同出处不重复追加", () => {
		writeEntity(cwd, { id: "t", kind: "tool", sources: "a", assertions: ["X."] });
		writeEntity(cwd, { id: "t", kind: "tool", sources: "a", assertions: ["X.", "Y."] });
		expect(readEntity(cwd, "t")!.meta.sources).toBe("a");
	});

	it("不存在的实体返回 null", () => {
		expect(readEntity(cwd, "missing")).toBeNull();
	});
});

describe("appendVerification / listVerifications", () => {
	it("追加记录并回读（检查 target/result/evidence 完整）", () => {
		appendVerification(cwd, { entityId: "t", validator: "code: echo ok", result: "passed", evidence: "e1" });
		const records = listVerifications(cwd, "t");
		expect(records).toHaveLength(1);
		expect(records[0].target).toBe("entities/t.md");
		expect(records[0].validator).toBe("code: echo ok");
		expect(records[0].result).toBe("passed");
		expect(records[0].evidence).toBe("e1");
	});

	it("同日多条自动序号 -2/-3，不覆盖旧记录", () => {
		appendVerification(cwd, { entityId: "t", validator: "v1", result: "passed", evidence: "e1" });
		appendVerification(cwd, { entityId: "t", validator: "v2", result: "passed", evidence: "e2" });
		appendVerification(cwd, { entityId: "t", validator: "v3", result: "passed", evidence: "e3" });
		const files = readdirSync(join(mem, "verifications")).filter((f) => f.includes("t"));
		expect(files.some((f) => f.endsWith(".md"))).toBe(true);
		expect(files.some((f) => f.endsWith("-2.md"))).toBe(true);
		expect(files.some((f) => f.endsWith("-3.md"))).toBe(true);
		expect(files).toHaveLength(3);
	});

	it("按实体 id 过滤；不匹配的 target 不返回", () => {
		appendVerification(cwd, { entityId: "a", validator: "v", result: "passed", evidence: "e" });
		appendVerification(cwd, { entityId: "b", validator: "v", result: "passed", evidence: "e" });
		expect(listVerifications(cwd, "a")).toHaveLength(1);
		expect(listVerifications(cwd, "b")).toHaveLength(1);
	});

	it("非法 result 的损坏记录被丢弃（不伪装成 passed）", () => {
		ensureMemoryDir(cwd);
		writeFileSync(join(mem, "verifications", "2026-01-01-bad.md"), "---\ntarget: entities/bad.md\nresult: weird\nevidence: x\n---\n");
		expect(listVerifications(cwd, "bad")).toHaveLength(0);
	});

	it("target 带 .memory/ 前缀的旧记录被丢弃（精确匹配 entities/<id>.md）", () => {
		ensureMemoryDir(cwd);
		writeFileSync(join(mem, "verifications", "2026-01-01-old.md"), "---\ntarget: .memory/entities/old.md\nchecked_at: " + new Date().toISOString() + "\nresult: passed\nevidence: x\n---\n");
		expect(listVerifications(cwd, "old")).toHaveLength(0);
	});

	it("checked_at 非完整 ISO（纯日期）的记录被丢弃", () => {
		ensureMemoryDir(cwd);
		writeFileSync(join(mem, "verifications", "2026-01-01-pure-date.md"), "---\ntarget: entities/pure-date.md\nchecked_at: 2026-01-01\nresult: passed\nevidence: x\n---\n");
		expect(listVerifications(cwd, "pure-date")).toHaveLength(0);
	});
});

describe("readLibrary", () => {
	it("一次配对全部实体与各自验证记录", () => {
		writeEntity(cwd, { id: "a", kind: "tool", sources: "s", assertions: ["A."] });
		writeEntity(cwd, { id: "b", kind: "concept", sources: "s", assertions: ["B."] });
		appendVerification(cwd, { entityId: "a", validator: "v1", result: "passed", evidence: "e1" });
		appendVerification(cwd, { entityId: "a", validator: "v2", result: "failed", evidence: "e2" });
		const library = readLibrary(cwd);
		expect(library).toHaveLength(2);
		const a = library.find((e) => e.meta.id === "a")!;
		const b = library.find((e) => e.meta.id === "b")!;
		expect(a.verifications).toHaveLength(2);
		expect(b.verifications).toHaveLength(0);
	});

	it("无合法 front-matter 的损坏实体不入库", () => {
		ensureMemoryDir(cwd);
		writeFileSync(join(mem, "entities", "broken.md"), "no front-matter at all");
		const library = readLibrary(cwd);
		expect(library).toHaveLength(0);
		expect(readEntity(cwd, "broken")).toBeNull();
	});
});

describe("校验规则", () => {
	it("id 必须小写连字符格式", () => {
		expect(validateId("tool-name")).toBeNull();
		expect(validateId("ToolName")).not.toBeNull();
		expect(validateId("tool_name")).not.toBeNull();
	});

	it("kind 必须是协议五类之一", () => {
		expect(validateKind("tool")).toBeNull();
		expect(validateKind("decision")).toBeNull();
		expect(validateKind("misc")).not.toBeNull();
	});
});