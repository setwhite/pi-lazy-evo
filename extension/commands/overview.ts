/**
 * /memory 总览：模式 + 四态分布 + 待验清单（TUI 展示，不注入）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeGate, type GateState } from "../gate.ts";
import { loadConfig } from "../config.ts";
import { listEntities, listVerifications } from "../store.ts";
import { notify } from "./notify.ts";

/** /memory：全库总览 */
async function overview(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const settings = loadConfig(ctx.cwd);
	const entities = listEntities(ctx.cwd);
	if (!entities.length) {
		notify(ctx, [`Mode: ${settings.mode}`, "Memory library is empty."], "Memory Overview");
		return;
	}
	const counts: Record<GateState, number> = { passed: 0, failed: 0, none: 0, stale: 0 };
	const watchlist: string[] = [];
	for (const meta of entities) {
		const state = computeGate(meta, listVerifications(ctx.cwd, meta.id)).state;
		counts[state]++;
		if (state === "none" || state === "stale") watchlist.push(`${meta.id} (${state === "none" ? "unverified" : "stale"})`);
	}
	const lines = [
		`Mode: ${settings.mode}`,
		`Entities ${entities.length} | passed ${counts.passed} / failed ${counts.failed} / unverified ${counts.none} / stale ${counts.stale}`,
	];
	if (watchlist.length) {
		lines.push(`Needs verification (${watchlist.length}): ${watchlist.join(", ")}`);
		lines.push("Run /memory verify for a batch check.");
	}
	notify(ctx, lines, "Memory Overview");
}

/** 注册 /memory */
export function registerOverviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("memory", { description: "Memory overview: mode, 4-state distribution and entities needing verification", handler: overview });
}