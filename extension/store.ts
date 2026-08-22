/**
 * 存储层：.memory/ 目录读写。
 * 实体文件 front-matter 恰好三字段（id/kind/sources）；验证记录只追加、绝不覆盖。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 记忆库根目录：优先 $MEMORY_DIR，其次 <cwd>/.memory */
export function memoryDir(cwd: string): string {
	return process.env.MEMORY_DIR ?? join(cwd, ".memory");
}

/** 实体元信息 */
export interface EntityMeta {
	/** 实体 id（文件名去除扩展名） */
	id: string;
	/** 文件绝对路径 */
	path: string;
	/** 实体类型 */
	kind: string;
	/** 出处 */
	sources: string;
	/** 文件修改时间戳（毫秒） */
	mtimeMs: number;
}

/** 实体全文 */
export interface EntityFile {
	meta: EntityMeta;
	/** 正文断言文本 */
	body: string;
	/** 原始文件内容 */
	raw: string;
}

/** 验证记录（解析后） */
export interface VerificationRecord {
	/** 记录文件绝对路径 */
	path: string;
	target: string;
	validator: string;
	checkedAt: string;
	result: "passed" | "failed";
	evidence: string;
	/** checked_at 解析为毫秒，解析失败为 0 */
	checkedAtMs: number;
}

/** 实体文件名合法格式（小写字母数字连字符） */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 合法的实体类型 */
const KINDS = ["tool", "person", "project", "concept", "decision"] as const;

/** id 合法性校验，返回错误信息或 null */
export function validateId(id: string): string | null {
	if (!ID_RE.test(id)) return "id must be lowercase-hyphenated (e.g. tool-name), got: " + id;
	return null;
}

/** kind 合法性校验，返回错误信息或 null */
export function validateKind(kind: string): string | null {
	if (!(KINDS as readonly string[]).includes(kind)) {
		return "kind must be one of " + KINDS.join("/") + ", got: " + kind;
	}
	return null;
}

/** 根系目录存在性检查，缺失则创建 */
export function ensureMemoryDir(cwd: string): string {
	const dir = memoryDir(cwd);
	for (const sub of ["", "entities", "verifications"]) {
		const p = join(dir, sub);
		if (!existsSync(p)) mkdirSync(p, { recursive: true });
	}
	return dir;
}

/** 列出全部实体（按文件名排序） */
export function listEntities(cwd: string): EntityMeta[] {
	const dir = join(memoryDir(cwd), "entities");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => {
			const p = join(dir, f);
			const meta = parseEntityMeta(p);
			return {
				id: meta?.id ?? f.slice(0, -3),
				path: p,
				kind: meta?.kind ?? "unknown",
				sources: meta?.sources ?? "",
				mtimeMs: statSync(p).mtimeMs,
			};
		});
}

/** 解析单个实体文件 front-matter 的 id/kind/sources（尽力而为，文件损坏返回 null） */
export function parseEntityMeta(path: string): Pick<EntityMeta, "id" | "kind" | "sources"> | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	if (!fm) return null;
	return {
		id: String(fm.id ?? ""),
		kind: String(fm.kind ?? ""),
		sources: String(fm.sources ?? ""),
	};
}

/** 读取实体全文 */
export function readEntity(cwd: string, id: string): EntityFile | null {
	const meta = listEntities(cwd).find((e) => e.id === id);
	if (!meta) return null;
	const raw = readFileSync(meta.path, "utf8");
	return { meta, raw, body: raw.replace(/^---[\s\S]*?---\n?/, "").trim() };
}

/** 写入或更新实体；更新时 source 追加新出处（分号分隔去重，保持 front-matter 单行） */
export function writeEntity(cwd: string, input: { id: string; kind: string; sources: string; assertions: string[] }): EntityFile {
	ensureMemoryDir(cwd);
	const existing = readEntity(cwd, input.id);
	const sources = existing
		? existing.meta.sources.split("；").includes(input.sources)
			? existing.meta.sources
			: existing.meta.sources + "；" + input.sources
		: input.sources;
	const frontmatter = `---\nid: ${input.id}\nkind: ${input.kind}\nsources: ${sources}\n---\n`;
	const raw = frontmatter + "\n" + input.assertions.join("\n") + "\n";
	writeFileSync(existing?.meta.path ?? join(memoryDir(cwd), "entities", input.id + ".md"), raw);
	return readEntity(cwd, input.id)!;
}

/** 列出验证记录；可指定实体 id 过滤（target 兼容带/不带 .memory/ 前缀） */
export function listVerifications(cwd: string, entityId?: string): VerificationRecord[] {
	const dir = join(memoryDir(cwd), "verifications");
	if (!existsSync(dir)) return [];
	const targetSuffix = entityId ? `entities/${entityId}.md` : null;
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.flatMap((f) => {
			const p = join(dir, f);
			return parseVerification(p, targetSuffix) ?? [];
		});
}

/** 解析单个验证记录文件；target 不匹配过滤条件时返回 null */
function parseVerification(path: string, targetSuffix: string | null): VerificationRecord | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	if (!fm) return null;
	const target = String(fm.target ?? "");
	if (targetSuffix && !target.endsWith(targetSuffix)) return null;
	const checkedAt = String(fm.checked_at ?? "");
	return {
		path,
		target,
		validator: String(fm.validator ?? ""),
		checkedAt,
		result: fm.result === "failed" ? "failed" : "passed",
		evidence: String(fm.evidence ?? ""),
		checkedAtMs: parseCheckedAt(checkedAt),
	};
}

/** checked_at 解析：带时刻按 ISO 解析；仅日期（旧记录）按本地当日最后一刻解释 */
function parseCheckedAt(checkedAt: string): number {
	if (checkedAt.includes("T")) {
		const ms = Date.parse(checkedAt);
		return Number.isNaN(ms) ? 0 : ms;
	}
	const dateMs = new Date(checkedAt.slice(0, 10) + "T23:59:59.999").getTime();
	return Number.isNaN(dateMs) ? 0 : dateMs;
}

/** 追加验证记录（只追加；同日多条自动加序号后缀） */
export function appendVerification(
	cwd: string,
	input: { entityId: string; validator: string; result: "passed" | "failed"; evidence: string; checkedAt?: string },
): string {
	ensureMemoryDir(cwd);
	const dir = join(memoryDir(cwd), "verifications");
	const stamp = new Date().toISOString();
	const checkedAt = input.checkedAt ?? stamp;
	const date = stamp.slice(0, 10);
	let name = `${date}-${input.entityId}`;
	let path = join(dir, name + ".md");
	for (let i = 2; existsSync(path); i++) path = join(dir, `${name}-${i}.md`);
	const raw = `---\ntarget: entities/${input.entityId}.md\nvalidator: ${input.validator}\nchecked_at: ${checkedAt}\nresult: ${input.result}\nevidence: ${input.evidence}\n---\n`;
	writeFileSync(path, raw);
	return path;
}

/** 简易 front-matter 解析：优先标准闭合块；兼容 v1 旧记录（只开头 ---、无闭合） */
function parseFrontmatter(raw: string): Record<string, string> | null {
	const closed = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
	const open = closed ?? /^---\r?\n([\s\S]*)$/.exec(raw);
	if (!open) return null;
	const fields: Record<string, string> = {};
	for (const line of open[1].split(/\r?\n/)) {
		const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
		if (kv) fields[kv[1]] = kv[2];
	}
	return fields;
}