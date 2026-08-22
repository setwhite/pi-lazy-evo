/**
 * TUI 输出：多行通知（各命令共用的薄工具）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** 输出多行文本到 TUI */
export function notify(ctx: ExtensionCommandContext, lines: string[], title = ""): void {
	ctx.ui.notify((title ? title + "\n" : "") + lines.join("\n"), "info");
}