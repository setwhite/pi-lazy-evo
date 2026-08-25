/**
 * /memory overview 子命令：模式 + 四态分布 + 待验清单（TUI 展示，不注入）。
 * 统计聚合由 gate.summarizeLibrary 纯函数承担，命令只做 IO → 门控 → 展示。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { gateLibrary, summarizeLibrary } from "../core/gate.ts";
import { loadConfig } from "../core/config.ts";
import { readLibrary } from "../core/store.ts";
import { notify } from "../tools/notify.ts";
import type { Runtime } from "../index.ts";

/** /memory overview：全库总览 */
export async function overview(_args: string, ctx: ExtensionCommandContext, _runtime: Runtime): Promise<void> {
	const mode = loadConfig(ctx.cwd).mode;
	const gated = gateLibrary(readLibrary(ctx.cwd));
	if (!gated.length) {
		notify(ctx, "Memory Overview", [`Mode: ${mode}`, "Memory library is empty."]);
		return;
	}
	const { counts, pending } = summarizeLibrary(gated);
	const lines = [
		`Mode: ${mode}`,
		`Entities ${gated.length} | passed ${counts.passed} / failed ${counts.failed} / unverified ${counts.none} / stale ${counts.stale}`,
	];
	if (pending.length) {
		lines.push(`Needs verification (${pending.length}): ${pending.map(({ id, state }) => `${id} (${state === "none" ? "unverified" : "stale"})`).join(", ")}`);
		lines.push("Run /memory verify for a batch check.");
	}
	notify(ctx, "Memory Overview", lines);
}
