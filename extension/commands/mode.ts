/**
 * /memory mode 挡位切换：查看或切换 manual|auto（只写 settings.json，
 * 不动工具集/提示词 → 不影响 prompt cache；auto 行为尚未实现，字段即状态）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, setMode } from "../core/config.ts";
import { notify } from "../tools/notify.ts";

/** /memory mode [auto|manual] */
async function mode(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const wanted = args.trim().toLowerCase();
	if (wanted !== "auto" && wanted !== "manual") {
		const current = loadConfig(ctx.cwd).mode;
		notify(ctx, "Memory Mode", [`Current mode: ${current}`, "Usage: /memory mode [auto|manual]"]);
		return;
	}
	const ok = setMode(ctx.cwd, wanted);
	notify(ctx, "Memory Mode", [
		`Mode ${ok ? "switched to" : "failed to switch to"} ${wanted}.`,
		wanted === "auto"
			? "Auto mode: background cheap-model worker settles & verifies memory at the token watermark (settings: autoWatermarkTokens / autoModel)."
			: "Manual mode: commands are the only triggers.",
	]);
}

/** 注册 /memory mode */
export function registerModeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("memory mode", {
		description: "Show or switch mode: /memory mode [auto|manual] (writes settings.json only)",
		handler: mode,
	});
}