/**
 * store 层单元测试：临时 MEMORY_DIR，不触碰真实库。
 * 数据一律由 tests/helpers.ts 按 protocol 真实格式落盘（扩展不写库，测试也不借道写侧 API）。
 * 覆盖：目录骨架、实体解析（含 depends-on 与非法忽略）、验证记录解析（脏数据丢弃）、
 * 整库配对、id/kind 校验规则。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMemoryDir, listEntities, listVerifications, memoryDir, readLibrary } from "../extension/store.ts";
import { validateId, validateKind } from "../extension/utils.ts";
import { writeEntityFile, writeRecordFile } from "./helpers.ts";

let cwd: string;
let mem: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-lazy-evo-store-"));
	mem = join(cwd, ".memory");
	process.env.MEMORY_DIR = mem;
});

/** 用例结束后还原 MEMORY_DIR，避免泄漏到其他测试文件（bun:test 单进程运行） */
afterEach(() => {
	delete process.env.MEMORY_DIR;
});

/** 直接写一个原始实体文件（构造损坏/非法等 fixture 造不出的输入） */
function rawEntity(name: string, content: string): void {
	mkdirSync(join(mem, "entities"), { recursive: true });
	writeFileSync(join(mem, "entities", name), content, "utf8");
}

/** 直接写一条原始验证记录文件（同上：绕过 fixture 制造脏数据） */
function rawRecord(name: string, content: string): void {
	mkdirSync(join(mem, "verifications"), { recursive: true });
	writeFileSync(join(mem, "verifications", name), content, "utf8");
}

describe("ensureMemoryDir", () => {
	it("创建 entities/verifications 骨架", () => {
		ensureMemoryDir(cwd);
		expect(existsSync(join(mem, "entities"))).toBe(true);
		expect(existsSync(join(mem, "verifications"))).toBe(true);
	});

	it("memoryDir 优先取 MEMORY_DIR 覆盖", () => {
		expect(memoryDir(cwd)).toBe(mem);
		delete process.env.MEMORY_DIR;
		expect(memoryDir(cwd)).toBe(join(cwd, ".memory"));
	});
});

describe("listEntities 实体解析", () => {
	it("四字段与正文均可回读，depends-on 逗号切分", () => {
		writeEntityFile(cwd, { id: "t", kind: "tool", sources: "src", dependsOn: ["extension/a.ts", "extension/b.ts"], body: ["A1: 断言一。"] });
		const [meta] = listEntities(cwd);
		expect(meta.id).toBe("t");
		expect(meta.kind).toBe("tool");
		expect(meta.sources).toBe("src");
		expect(meta.dependsOn).toEqual(["extension/a.ts", "extension/b.ts"]);
		expect(meta.mtimeMs).toBeGreaterThan(0);
	});

	it("未声明 depends-on 时为空数组", () => {
		writeEntityFile(cwd, { id: "t" });
		expect(listEntities(cwd)[0].dependsOn).toEqual([]);
	});

	it("中文 id 实体正常入库（回归：query/verify 空库误报）", () => {
		writeEntityFile(cwd, { id: "小小吸血姬", body: ["A1: 断言。"] });
		expect(listEntities(cwd)[0].id).toBe("小小吸血姬");
	});

	it("front-matter 值带包裹引号仍能解析", () => {
		rawEntity("quoted.md", '---\nid: quoted\nkind: tool\nsources: "带引号的出处"\n---\n\nA1: 断言。\n');
		expect(listEntities(cwd)[0].sources).toBe("带引号的出处");
	});

	it("损坏实体不入库：无 front-matter / 未闭合 / id 或 kind 非法", () => {
		rawEntity("broken.md", "no front-matter at all");
		rawEntity("open.md", "---\nid: open\nkind: tool\nsources: x\n\n正文无闭合分隔线");
		rawEntity("bad-id.md", "---\nid: bad/id\nkind: tool\nsources: x\n---\n");
		rawEntity("bad-kind.md", "---\nid: bad-kind\nkind: misc\nsources: x\n---\n");
		expect(listEntities(cwd)).toHaveLength(0);
	});

	it("非 .md 文件与空目录一律忽略", () => {
		rawEntity("note.txt", "---\nid: note\nkind: tool\nsources: x\n---\n");
		expect(listEntities(cwd)).toHaveLength(0);
	});

	it("正文含 --- 分隔线不破坏 front-matter 解析", () => {
		writeEntityFile(cwd, { id: "doc", kind: "tool", sources: "t", body: ["A1: 第一行。", "---", "A2: 第二行。"] });
		const [meta] = listEntities(cwd);
		expect(meta.sources).toBe("t");
		expect(meta.id).toBe("doc");
	});
});

describe("listVerifications 记录解析", () => {
	const AT = "2026-08-30T10:00:00+08:00";

	it("解析 target/validator/result/evidence/checkedAtMs 全字段", () => {
		writeRecordFile(cwd, { entityId: "t", checkedAt: AT, result: "passed", validator: "code: echo ok", body: "e1" });
		const [r] = listVerifications(cwd, "t");
		expect(r.target).toBe("entities/t.md");
		expect(r.validator).toBe("code: echo ok"); // 纯透传：词表外的值不报错、不猜测
		expect(r.result).toBe("passed");
		expect(r.evidence).toBe("e1");
		expect(r.checkedAtMs).toBe(Date.parse(AT));
	});

	it("按实体归位子目录读取；entityId 过滤时 target 不匹配的不返回", () => {
		writeRecordFile(cwd, { entityId: "a", checkedAt: AT, result: "passed" });
		writeRecordFile(cwd, { entityId: "b", checkedAt: AT, result: "passed" });
		expect(listVerifications(cwd, "a")).toHaveLength(1);
		expect(listVerifications(cwd, "b")).toHaveLength(1);
		expect(listVerifications(cwd)).toHaveLength(2);
	});

	it("同一实体的多条记录全部读回（门控只信 checked_at，不信文件名）", () => {
		writeRecordFile(cwd, { entityId: "t", checkedAt: AT, result: "passed", seq: 1 });
		writeRecordFile(cwd, { entityId: "t", checkedAt: AT, result: "failed", seq: 2 });
		expect(listVerifications(cwd, "t")).toHaveLength(2);
	});

	it("仍兼容读取旧平铺结构（verifications/<日期>-<id>.md）", () => {
		rawRecord("2026-08-29-t.md", `---\ntarget: entities/t.md\nvalidator: v\nchecked_at: ${AT}\nresult: passed\n---\nlegacy evidence\n`);
		expect(listVerifications(cwd, "t")[0].evidence).toBe("legacy evidence");
	});

	it("脏数据一律丢弃：result 非法 / checked_at 非完整 ISO（纯日期）", () => {
		rawRecord("bad-result.md", "---\ntarget: entities/bad.md\nchecked_at: 2026-01-01T00:00:00Z\nresult: weird\n---\nx\n");
		rawRecord("pure-date.md", "---\ntarget: entities/d.md\nchecked_at: 2026-01-01\nresult: passed\n---\nx\n");
		expect(listVerifications(cwd)).toHaveLength(0);
	});

	it("target 必须精确匹配 entities/<id>.md：带 .memory/ 前缀的旧写法读不到", () => {
		rawRecord("old.md", `---\ntarget: .memory/entities/old.md\nchecked_at: ${AT}\nresult: passed\n---\nx\n`);
		expect(listVerifications(cwd, "old")).toHaveLength(0);
	});

	it("旧版 evidence 字段不再读取：证据只取正文", () => {
		rawRecord("legacy.md", `---\ntarget: entities/legacy.md\nvalidator: v\nchecked_at: ${AT}\nresult: passed\nevidence: legacy-field\n---\n正文证据\n`);
		expect(listVerifications(cwd, "legacy")[0].evidence).toBe("正文证据");
	});

	it("证据正文含 --- 行不被截断", () => {
		writeRecordFile(cwd, { entityId: "t", checkedAt: AT, result: "passed", body: "命令输出\n---\n尾部" });
		expect(listVerifications(cwd, "t")[0].evidence).toBe("命令输出\n---\n尾部");
	});
});

describe("readLibrary 全库配对", () => {
	const AT = "2026-08-30T10:00:00+08:00";

	it("一次配对全部实体与各自验证记录", () => {
		writeEntityFile(cwd, { id: "a" });
		writeEntityFile(cwd, { id: "b" });
		writeRecordFile(cwd, { entityId: "a", checkedAt: AT, result: "passed", seq: 1 });
		writeRecordFile(cwd, { entityId: "a", checkedAt: AT, result: "failed", seq: 2 });
		const library = readLibrary(cwd);
		expect(library).toHaveLength(2);
		expect(library.find((e) => e.meta.id === "a")!.verifications).toHaveLength(2);
		expect(library.find((e) => e.meta.id === "b")!.verifications).toHaveLength(0);
	});

	it("孤儿记录（实体不存在）不进结果，实体无记录时配空数组", () => {
		writeRecordFile(cwd, { entityId: "ghost", checkedAt: AT, result: "passed" });
		writeEntityFile(cwd, { id: "a" });
		const library = readLibrary(cwd);
		expect(library.map((e) => e.meta.id)).toEqual(["a"]);
		expect(library[0].verifications).toEqual([]);
	});
});

describe("校验规则", () => {
	it("id 只是名字：拒绝空/换行/路径分隔符/保留词 all", () => {
		expect(validateId("tool-name")).toBeNull();
		expect(validateId("ToolName")).toBeNull();
		expect(validateId("tool_name")).toBeNull();
		expect(validateId("Bad Id")).toBeNull();
		expect(validateId("小小吸血姬")).toBeNull();
		expect(validateId("")).not.toBeNull();
		expect(validateId("   ")).not.toBeNull();
		expect(validateId("bad\nid")).not.toBeNull();
		expect(validateId("bad/id")).not.toBeNull();
		expect(validateId("bad\\id")).not.toBeNull();
		// 保留词：与 /memory verify all 撞车
		expect(validateId("all")).not.toBeNull();
		expect(validateId(" All ")).toBeNull(); // 仅精确小写 all 被保留（id 区分大小写）
	});

	it("kind 必须是协议五类之一", () => {
		expect(validateKind("tool")).toBeNull();
		expect(validateKind("decision")).toBeNull();
		expect(validateKind("misc")).not.toBeNull();
	});
});

describe("验证记录防重名（扩展不写库，命名归代理）", () => {
	it("同日多条各自成文件且全部读得回，不互相覆盖", () => {
		const at = "2026-08-30T10:00:00+08:00";
		writeRecordFile(cwd, { entityId: "t", checkedAt: at, result: "failed", body: "第一次推翻", seq: 1 });
		writeRecordFile(cwd, { entityId: "t", checkedAt: at, result: "passed", body: "修正后复验", seq: 2 });
		const evidences = listVerifications(cwd, "t").map((r) => r.evidence);
		expect(evidences).toContain("第一次推翻");
		expect(evidences).toContain("修正后复验");
	});
});
