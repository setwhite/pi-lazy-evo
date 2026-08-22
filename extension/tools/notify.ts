/**
 * TUI 输出工具：多行通知（各命令共用的薄工具）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** 输出通知到 TUI（标题 + 正文多行） */
export function notify(ctx: ExtensionCommandContext, title: string, lines: string[]): void {
	ctx.ui.notify((title ? title + "\n" : "") + lines.join("\n"), "info");
}