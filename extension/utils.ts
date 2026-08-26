/**
 * 纯工具：无 IO 无业务，供各层共用。
 * front-matter 解析 / 实体格式校验 / 消息文本提取 / TUI 通知。
 */

/** 解析 front-matter 为字段映射；仅接受完整闭合（结尾 --- 独占一行），字段一律字符串 */
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

/** 剥离 front-matter 头，返回正文（其余全文 trim） */
export function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

/** id 禁用字符：换行/制表符（破坏 front-matter 单行）与路径分隔符（id 用作文件名） */
const ID_FORBIDDEN_RE = /[\r\n\t/\\]/;

/** id 合法性校验，返回错误信息或 null（id 只是名字：任意非空单行文本） */
export function validateId(id: string): string | null {
	if (id.trim().length === 0) return "id must not be empty";
	if (ID_FORBIDDEN_RE.test(id)) return "id must not contain newlines, tabs, or path separators, got: " + id;
	return null;
}

/** 合法实体类型（协议五类） */
const KINDS = ["tool", "person", "project", "concept", "decision"] as const;

/** kind 合法性校验，返回错误信息或 null */
export function validateKind(kind: string): string | null {
	if (!(KINDS as readonly string[]).includes(kind)) {
		return "kind must be one of " + KINDS.join("/") + ", got: " + kind;
	}
	return null;
}

/** 消息 content 提取纯文本（兼容字符串与 block 数组） */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
			.map((b) => (typeof b.text === "string" ? b.text : ""))
			.join("");
	}
	return "";
}

/** 最小 notify 视口：命令 ctx 与事件 ctx 通用（只依赖 ui.notify 的结构） */
export interface HasNotifyUi {
	ui: { notify(message: string, type?: "error" | "info" | "warning"): void };
}

/** 输出通知到 TUI（标题 + 正文多行） */
export function notify(ctx: HasNotifyUi, title: string, lines: string[]): void {
	ctx.ui.notify((title ? title + "\n" : "") + lines.join("\n"), "info");
}