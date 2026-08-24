/**
 * 验证域：.memory/verifications/ 读写（只追加、绝不覆盖）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../tools/frontmatter.ts";
import { ensureMemoryDir, memoryDir } from "./layout.ts";

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
	if (fm.result !== "passed" && fm.result !== "failed") return null;
	const checkedAt = String(fm.checked_at ?? "");
	return {
		path,
		target,
		validator: String(fm.validator ?? ""),
		checkedAt,
		result: fm.result,
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
