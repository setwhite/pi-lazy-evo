/**
 * 消息文本提取工具：兼容字符串与 block 数组。
 * actions（素材抽取）与 workers（子进程输出）两条通道共用。
 */

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
