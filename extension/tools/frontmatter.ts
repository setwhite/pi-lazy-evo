/**
 * front-matter 解析工具：协议文件（实体正文 / 验证记录）共用的简单解析。
 * 只支持协议的字段子集（id/kind/sources/target/validator/checked_at/result 等），
 * 解析结果一律为字符串，由调用方按字段语义解释。
 * 严格模式：仅接受完整闭合的 front-matter（结尾 --- 独占一行），其余一律 null。
 */

/** 解析 front-matter 为字段映射；无合法闭合头返回 null */
export function parseFrontmatter(raw: string): Record<string, string> | null {
	const open = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
	if (!open) return null;
	const fields: Record<string, string> = {};
	for (const line of open[1].split(/\r?\n/)) {
		const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
		if (kv) fields[kv[1]] = kv[2];
	}
	return fields;
}
