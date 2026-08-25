/**
 * 实体域：.memory/entities/ 读写。
 * 实体文件 front-matter 恰好三字段（id/kind/sources）；id/kind 校验在 tools/validate.ts。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../tools/frontmatter.ts";
import { validateId, validateKind } from "../tools/validate.ts";
import { ensureMemoryDir, memoryDir } from "./layout.ts";

export { validateId, validateKind } from "../tools/validate.ts";

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

/** 列出全部实体（按文件名排序；仅收录 front-matter 与 id/kind 格式合法的实体，损坏/非法文件不入库；内部：readEntity/readLibrary 共用） */
export function listEntities(cwd: string): EntityMeta[] {
	const dir = join(memoryDir(cwd), "entities");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.flatMap((f) => {
			const p = join(dir, f);
			const meta = parseEntityMeta(p);
			if (!meta?.id || !meta.kind) return [];
			if (validateId(meta.id) || validateKind(meta.kind)) return [];
			return [{ id: meta.id, kind: meta.kind, sources: meta.sources, path: p, mtimeMs: statSync(p).mtimeMs }];
		});
}

/** 解析单个实体文件 front-matter 的 id/kind/sources（尽力而为，文件损坏返回 null；内部：listEntities 使用） */
function parseEntityMeta(path: string): Pick<EntityMeta, "id" | "kind" | "sources"> | null {
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
	return { meta, raw, body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim() };
}

/** 合并出处：已有且不含新出处则分号追加（保持 front-matter 单行） */
function mergeSources(existing: string | undefined, source: string): string {
	if (!existing) return source;
	return existing.split("；").includes(source) ? existing : `${existing}；${source}`;
}

/** 写入或更新实体；更新时 source 追加新出处（分号分隔去重，保持 front-matter 单行） */
export function writeEntity(cwd: string, input: { id: string; kind: string; sources: string; assertions: string[] }): EntityFile {
	const idError = validateId(input.id);
	if (idError) throw new Error(idError);
	const kindError = validateKind(input.kind);
	if (kindError) throw new Error(kindError);
	ensureMemoryDir(cwd);
	const existing = readEntity(cwd, input.id);
	const sources = mergeSources(existing?.meta.sources, input.sources);
	const path = existing?.meta.path ?? join(memoryDir(cwd), "entities", input.id + ".md");
	const raw = `---\nid: ${input.id}\nkind: ${input.kind}\nsources: ${sources}\n---\n` + "\n" + input.assertions.join("\n") + "\n";
	writeFileSync(path, raw);
	return { meta: { id: input.id, path, kind: input.kind, sources, mtimeMs: statSync(path).mtimeMs }, raw, body: input.assertions.join("\n") };
}
