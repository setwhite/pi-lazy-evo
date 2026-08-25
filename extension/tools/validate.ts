/**
 * 实体格式校验（确定性小工具）：id / kind 合法性，无 IO 无依赖。
 */
/** id 禁用字符：换行/制表符（破坏 front-matter 单行）与路径分隔符（id 用作文件名） */
const ID_FORBIDDEN_RE = /[\r\n\t/\\]/;

/** id 合法性校验，返回错误信息或 null（id 只是名字：任意非空单行文本） */
export function validateId(id: string): string | null {
	if (id.trim().length === 0) return "id must not be empty";
	if (ID_FORBIDDEN_RE.test(id)) return "id must not contain newlines, tabs, or path separators, got: " + id;
	return null;
}

/** 合法的实体类型 */
const KINDS = ["tool", "person", "project", "concept", "decision"] as const;

/** kind 合法性校验，返回错误信息或 null */
export function validateKind(kind: string): string | null {
	if (!(KINDS as readonly string[]).includes(kind)) {
		return "kind must be one of " + KINDS.join("/") + ", got: " + kind;
	}
	return null;
}
