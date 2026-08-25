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
	/** 证据：记录正文（front-matter 之外的全部内容） */
	evidence: string;
	/** checked_at 解析为毫秒，解析失败为 0 */
	checkedAtMs: number;
}

/** 列出验证记录；可指定实体 id 过滤（target 精确等于 entities/<id>.md） */
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

/** 解析单个验证记录文件；target 不匹配过滤条件、或无法定时刻时返回 null */
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
	const checkedAtMs = parseCheckedAt(checkedAt);
	if (checkedAtMs <= 0) return null; // 无法定时刻即无效记录，不参与门控
	return {
		path,
		target,
		validator: String(fm.validator ?? ""),
		checkedAt,
		result: fm.result,
		evidence: raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim(),
		checkedAtMs,
	};
}

/** checked_at 解析：仅接受完整 ISO 时间戳（含时刻）；其余一律无法定时刻返回 0 */
function parseCheckedAt(checkedAt: string): number {
	if (!checkedAt.includes("T")) return 0;
	const ms = Date.parse(checkedAt);
	return Number.isNaN(ms) ? 0 : ms;
}

/** 追加验证记录（只追加；同日多条自动加序号后缀）；证据写在正文 */
export function appendVerification(
	cwd: string,
	input: { entityId: string; validator: string; result: "passed" | "failed"; body: string; checkedAt?: string },
): string {
	ensureMemoryDir(cwd);
	const dir = join(memoryDir(cwd), "verifications");
	const stamp = new Date().toISOString();
	const checkedAt = input.checkedAt ?? stamp;
	const date = stamp.slice(0, 10);
	let name = `${date}-${input.entityId}`;
	let path = join(dir, name + ".md");
	for (let i = 2; existsSync(path); i++) path = join(dir, `${name}-${i}.md`);
	const raw = `---\ntarget: entities/${input.entityId}.md\nvalidator: ${input.validator}\nchecked_at: ${checkedAt}\nresult: ${input.result}\n---\n\n${input.body.trim()}\n`;
	writeFileSync(path, raw);
	return path;
}
