/**
 * 存储域：记忆库布局 + 实体与验证记录的读取（尽力解析 + 非法忽略）+ 全库配对。
 * 只读：零工具注入下代理按 protocol 手册用通用工具直接落盘，扩展不写库（仅预建目录骨架）。
 * 验证记录按实体归位于 verifications/<id>/ 子目录（旧平铺结构仍可读）；
 * 门控不读记录文件名（只信 checked_at 与 mtime），目录结构只是防重名与可维护性。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, stripFrontmatter, validateId, validateKind } from "./utils.ts";

// ---- 布局 ----

/** 记忆库根目录：优先 $MEMORY_DIR，其次 <cwd>/.memory（cwd 未就绪回退进程目录——补全等早触发路径的防御） */
export function memoryDir(cwd: string | undefined): string {
	return process.env.MEMORY_DIR ?? join(cwd ?? process.cwd(), ".memory");
}

/** 确保 entities/verifications 目录骨架存在（命令派发前调用：代理要往那儿写，目录得先在） */
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
	/** 依赖的仓库内文件相对路径列表（depends-on front-matter，逗号分隔；空 = 不依赖） */
	dependsOn: string[];
	/** 文件修改时间戳（毫秒） */
	mtimeMs: number;
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

/** 解析实体 front-matter 的 id/kind/sources/depends-on；文件损坏返回 null */
function parseEntityMeta(path: string): Pick<EntityMeta, "id" | "kind" | "sources" | "dependsOn"> | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	if (!fm) return null;
	const dependsOn = (fm["depends-on"] ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	return { id: String(fm.id ?? ""), kind: String(fm.kind ?? ""), sources: String(fm.sources ?? ""), dependsOn };
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

/** 列出验证记录；entityId 过滤时 target 必须精确匹配 entities/<id>.md。
 * 支持一层子目录（按实体归位）：verifications/<id>/<日期>[-N].md，兼容旧平铺结构。 */
export function listVerifications(cwd: string, entityId?: string): VerificationRecord[] {
	const dir = join(memoryDir(cwd), "verifications");
	if (!existsSync(dir)) return [];
	const targetSuffix = entityId ? `entities/${entityId}.md` : null;
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const f of readdirSync(p)) if (f.endsWith(".md")) files.push(join(p, f));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(p);
		}
	}
	return files.sort().flatMap((p) => parseVerification(p, targetSuffix) ?? []);
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