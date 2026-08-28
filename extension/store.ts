/**
 * 存储域：记忆库布局 + 实体读写 + 验证记录（只追加）+ 全库配对。
 * 目录骨架由扩展预建；读取层"尽力解析 + 非法忽略"（损坏/非法的文件一律不入库）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, stripFrontmatter, validateId, validateKind } from "./utils.ts";

// ---- 布局 ----

/** 记忆库根目录：优先 $MEMORY_DIR，其次 <cwd>/.memory（cwd 未就绪回退进程目录——补全等早触发路径的防御） */
export function memoryDir(cwd: string | undefined): string {
	return process.env.MEMORY_DIR ?? join(cwd ?? process.cwd(), ".memory");
}

/** 确保 entities/verifications 目录骨架存在（写入口与命令派发前调用） */
export function ensureMemoryDir(cwd: string): string {
	const dir = memoryDir(cwd);
	for (const sub of ["", "entities", "verifications"]) {
		const p = join(dir, sub);
		if (!existsSync(p)) mkdirSync(p, { recursive: true });
	}
	return dir;
}

// ---- 实体 ----

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
	/** 原始文件内容 */
	raw: string;
	/** 正文断言文本（front-matter 之外） */
	body: string;
}

/** 列出全部实体：仅收录 front-matter 与 id/kind 均合法的文件，其余忽略 */
export function listEntities(cwd: string): EntityMeta[] {
	const dir = join(memoryDir(cwd), "entities");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.flatMap((f) => {
			const p = join(dir, f);
			const meta = parseEntityMeta(p);
			if (!meta || validateId(meta.id) || validateKind(meta.kind)) return [];
			return [{ ...meta, path: p, mtimeMs: statSync(p).mtimeMs }];
		});
}

/** 解析实体 front-matter 的 id/kind/sources；文件损坏返回 null */
function parseEntityMeta(path: string): Pick<EntityMeta, "id" | "kind" | "sources"> | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	if (!fm) return null;
	return { id: String(fm.id ?? ""), kind: String(fm.kind ?? ""), sources: String(fm.sources ?? "") };
}

/** 读取实体全文；不存在返回 null */
export function readEntity(cwd: string, id: string): EntityFile | null {
	const meta = listEntities(cwd).find((e) => e.id === id);
	if (!meta) return null;
	const raw = readFileSync(meta.path, "utf8");
	return { meta, raw, body: stripFrontmatter(raw) };
}

/** 合并出处：已有且不含新出处则分号追加（保持 front-matter 单行） */
function mergeSources(existing: string | undefined, source: string): string {
	if (!existing) return source;
	return existing.split("；").includes(source) ? existing : `${existing}；${source}`;
}

/** 写入或更新实体；更新时出处追加去重；id/kind 非法抛错 */
export function writeEntity(cwd: string, input: { id: string; kind: string; sources: string; assertions: string[] }): EntityFile {
	const idError = validateId(input.id);
	if (idError) throw new Error(idError);
	const kindError = validateKind(input.kind);
	if (kindError) throw new Error(kindError);
	ensureMemoryDir(cwd);
	const existing = readEntity(cwd, input.id);
	const sources = mergeSources(existing?.meta.sources, input.sources);
	const path = existing?.meta.path ?? join(memoryDir(cwd), "entities", input.id + ".md");
	const raw = `---\nid: ${input.id}\nkind: ${input.kind}\nsources: ${sources}\n---\n\n${input.assertions.join("\n")}\n`;
	writeFileSync(path, raw);
	const body = input.assertions.join("\n");
	return { meta: { id: input.id, path, kind: input.kind, sources, mtimeMs: statSync(path).mtimeMs }, raw, body };
}

// ---- 验证记录 ----

/** 验证记录（解析后） */
export interface VerificationRecord {
	/** 记录文件绝对路径 */
	path: string;
	/** 目标实体引用 entities/<id>.md */
	target: string;
	validator: string;
	checkedAt: string;
	result: "passed" | "failed";
	/** 证据：记录正文（front-matter 之外的全部内容） */
	evidence: string;
	/** checked_at 解析为毫秒 */
	checkedAtMs: number;
}

/** 列出验证记录；entityId 过滤时 target 必须精确匹配 entities/<id>.md */
export function listVerifications(cwd: string, entityId?: string): VerificationRecord[] {
	const dir = join(memoryDir(cwd), "verifications");
	if (!existsSync(dir)) return [];
	const targetSuffix = entityId ? `entities/${entityId}.md` : null;
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.flatMap((f) => parseVerification(join(dir, f), targetSuffix) ?? []);
}

/** 解析单条验证记录；target 不匹配 / result 非法 / 无法定时刻一律丢弃 */
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
	if (targetSuffix && target !== targetSuffix) return null;
	if (fm.result !== "passed" && fm.result !== "failed") return null;
	const checkedAt = String(fm.checked_at ?? "");
	const checkedAtMs = checkedAt.includes("T") ? Date.parse(checkedAt) : NaN;
	if (!(checkedAtMs > 0)) return null; // checked_at 必须是完整 ISO（含时刻）
	return { path, target, validator: String(fm.validator ?? ""), checkedAt, result: fm.result, evidence: stripFrontmatter(raw), checkedAtMs };
}

/** 追加验证记录（只追加；同日多条自动加序号后缀），返回记录文件路径 */
export function appendVerification(
	cwd: string,
	input: { entityId: string; validator: string; result: "passed" | "failed"; body: string; checkedAt?: string },
): string {
	ensureMemoryDir(cwd);
	const dir = join(memoryDir(cwd), "verifications");
	const stamp = new Date().toISOString();
	const base = `${stamp.slice(0, 10)}-${input.entityId}`;
	let path = join(dir, base + ".md");
	for (let i = 2; existsSync(path); i++) path = join(dir, `${base}-${i}.md`);
	const raw = `---\ntarget: entities/${input.entityId}.md\nvalidator: ${input.validator}\nchecked_at: ${input.checkedAt ?? stamp}\nresult: ${input.result}\n---\n\n${input.body.trim()}\n`;
	writeFileSync(path, raw);
	return path;
}

// ---- 全库配对 ----

/** 实体与其验证记录配对（readLibrary 返回项） */
export interface EntityWithVerifications {
	meta: EntityMeta;
	verifications: VerificationRecord[];
}

/** 一次 IO 读完整个库：实体全量 + 全部验证记录按 target 分组配对 */
export function readLibrary(cwd: string): EntityWithVerifications[] {
	const byTarget = new Map<string, VerificationRecord[]>();
	for (const v of listVerifications(cwd)) {
		const list = byTarget.get(v.target) ?? [];
		list.push(v);
		byTarget.set(v.target, list);
	}
	return listEntities(cwd).map((meta) => ({ meta, verifications: byTarget.get(`entities/${meta.id}.md`) ?? [] }));
}