/**
 * TUI 输出工具：多行通知（各命令共用的薄工具）。
 * ui 用窄接口：任何带 ui（notify）的 ctx 都能用（命令 ctx 与事件 ctx 均可）。
 */

/** 最小 notify 视口：只依赖 ui.notify 的结构（message + 可选 level） */
export interface HasNotifyUi {
	ui: { notify(message: string, type?: "error" | "info" | "warning"): void };
}

/** 输出通知到 TUI（标题 + 正文多行） */
export function notify(ctx: HasNotifyUi, title: string, lines: string[]): void {
	ctx.ui.notify((title ? title + "\n" : "") + lines.join("\n"), "info");
}