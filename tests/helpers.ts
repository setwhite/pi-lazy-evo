/**
 * 测试夹具：按 protocol/ 手册的真实格式直接落盘，与代理的实际产物同构。
 * 扩展不写库（零工具注入下代理用通用 write 工具自己落盘），所以测试不得依赖扩展的写侧 API——
 * 否则 fixture 走的是生产不走的路径，字段遗漏这类格式漂移永远测不出来。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDir } from "../extension/store.ts";

/** 实体夹具入参 */
export interface EntityFixture {
	/** 实体 id（同时作文件名） */
	id: string;
	/** 类型（缺省 concept） */
	kind?: string;
	/** 出处（缺省 fixture） */
	sources?: string;
	/** depends-on 相对路径列表（缺省不写该字段） */
	dependsOn?: string[];
	/** 正文行（缺省一条占位断言） */
	body?: string[];
}

/** 验证记录夹具入参 */
export interface RecordFixture {
	/** 目标实体 id（写成 target: entities/<id>.md） */
	entityId: string;
	/** 验证时刻 ISO 串——门控只信 checked_at，用例必须显式控制 */
	checkedAt: string;
	/** 结果 */
	result: "passed" | "failed";
	/** validator 取值（缺省 recompute；透传语义，任意字符串皆可） */
	validator?: string;
	/** 证据正文（front-matter 之外） */
	body?: string;
	/** 同日多条序号（≥2 时文件名加 -N，与手册的防重名规则一致） */
	seq?: number;
}

/** 写实体文件 entities/<id>.md，返回路径 */
export function writeEntityFile(cwd: string, f: EntityFixture): string {
	const dir = join(memoryDir(cwd), "entities");
	mkdirSync(dir, { recursive: true });
	const lines = ["---", `id: ${f.id}`, `kind: ${f.kind ?? "concept"}`, `sources: ${f.sources ?? "fixture"}`];
	if (f.dependsOn?.length) lines.push(`depends-on: ${f.dependsOn.join(", ")}`);
	lines.push("---", "", ...(f.body ?? ["A1: 断言。"]), "");
	const path = join(dir, `${f.id}.md`);
	writeFileSync(path, lines.join("\n"), "utf8");
	return path;
}

/** 写验证记录 verifications/<id>/<日期>[-N].md，返回路径 */
export function writeRecordFile(cwd: string, f: RecordFixture): string {
	const dir = join(memoryDir(cwd), "verifications", f.entityId);
	mkdirSync(dir, { recursive: true });
	const suffix = f.seq && f.seq > 1 ? `-${f.seq}` : "";
	const path = join(dir, `${f.checkedAt.slice(0, 10)}${suffix}.md`);
	const raw = [
		"---",
		`target: entities/${f.entityId}.md`,
		`validator: ${f.validator ?? "recompute"}`,
		`checked_at: ${f.checkedAt}`,
		`result: ${f.result}`,
		"---",
		"",
		(f.body ?? "证据").trim(),
		"",
	].join("\n");
	writeFileSync(path, raw, "utf8");
	return path;
}
