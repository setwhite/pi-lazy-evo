/**
 * front-matter 解析工具：协议文件（实体正文 / 验证记录）共用的简单解析。
 * 只支持协议的字段子集（id/kind/sources/target/validator/checked_at/result/evidence 等），
 * 解析结果一律为字符串，由调用方按字段语义解释。
 */

/** 解析 front-matter 为字段映射；无合法头（未闭合或缺失）返回 null */
export function parseFrontmatter(raw: string): Record<string, string> | null {
	// 优先标准闭合块；兼容 v1 旧记录（只开头 ---、无闭合）
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