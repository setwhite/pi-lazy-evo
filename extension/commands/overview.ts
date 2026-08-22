/**
 * /memory 总览：模式 + 四态分布 + 待验清单（TUI 展示，不注入）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NEEDS_VERIFICATION, gateLibrary, type GateState } from "../gate.ts";
import { loadConfig } from "../config.ts";
import { readLibrary } from "../store.ts";
import { notify } from "../tools/notify.ts";

const ZERO_COUNTS: Record<GateState, number> = { passed: 0, failed: 0, none: 0, stale: 0 };

/** /memory：全库总览 */
async function overview(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const mode = loadConfig(ctx.cwd).mode;
	const gated = gateLibrary(readLibrary(ctx.cwd));
	if (!gated.length) {
		notify(ctx, "Memory Overview", [`Mode: ${mode}`, "Memory library is empty."]);
		return;
	}
	const counts: Record<GateState, number> = { ...ZERO_COUNTS };
	const watchlist: string[] = [];
	for (const { meta, gate } of gated) {
		counts[gate.state]++;
		if (NEEDS_VERIFICATION.has(gate.state)) {
			watchlist.push(`${meta.id} (${gate.state === "none" ? "unverified" : "stale"})`);
		}
	}
	const lines = [
		`Mode: ${mode}`,
		`Entities ${gated.length} | passed ${counts.passed} / failed ${counts.failed} / unverified ${counts.none} / stale ${counts.stale}`,
	];
	if (watchlist.length) {
		lines.push(`Needs verification (${watchlist.length}): ${watchlist.join(", ")}`);
		lines.push("Run /memory verify for a batch check.");
	}
	notify(ctx, "Memory Overview", lines);
}

/** 注册 /memory */
export function registerOverviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("memory", { description: "Memory overview: mode, 4-state distribution and entities needing verification", handler: overview });
}