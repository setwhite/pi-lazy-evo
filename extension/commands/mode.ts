/**
 * /memory mode 子命令：查看或切换 manual|auto（只写 settings.json，
 * 不动工具集/提示词 → 不影响 prompt cache；auto 挡由 subagents/auto.ts 水位触发双 worker）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, setMode, type MemoryMode } from "../core/config.ts";
import { notify } from "../tools/notify.ts";
import type { Runtime } from "../index.ts";

/** 模式含义（一行文案）：auto = 命令 + 后台 record/verify；manual = 仅命令 */
const MODE_LABEL: Record<MemoryMode, string> = {
	auto: "commands + background record & verify",
	manual: "commands only",
};

/** /memory mode [auto|manual] */
export async function mode(args: string, ctx: ExtensionCommandContext, _runtime: Runtime): Promise<void> {
	const wanted = args.trim().toLowerCase();
	if (wanted !== "auto" && wanted !== "manual") {
		const current = loadConfig(ctx.cwd).mode;
		notify(ctx, "Memory Mode", [
			`Current mode: ${current} (${MODE_LABEL[current]}).`,
			"Usage: /memory mode [auto|manual]",
		]);
		return;
	}
	const ok = setMode(ctx.cwd, wanted);
	notify(ctx, "Memory Mode", [
		ok ? `Mode switched to ${wanted} (${MODE_LABEL[wanted]}).` : `Failed to switch to ${wanted}.`,
	]);
}
