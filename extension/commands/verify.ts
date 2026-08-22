/**
 * /memory verify 验证扳机：算出待验清单（unverified/stale），
 * 注入提醒让 agent 亲自验证（扩展不跑任何检查）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SettlerActions } from "../agents/settler/agent.ts";
import { computeGate } from "../gate.ts";
import { listEntities, listVerifications } from "../store.ts";
import { notify } from "./notify.ts";

/** /memory verify [id]：列出待验实体并注入验证提醒 */
async function verify(args: string, ctx: ExtensionCommandContext, actions: SettlerActions): Promise<void> {
	const targetId = args.trim();
	const all = listEntities(ctx.cwd);
	const metas = targetId ? all.filter((e) => e.id === targetId) : all;
	if (!metas.length) {
		notify(ctx, [targetId ? `Entity not found: ${targetId}` : "Memory library is empty."], "Memory Verify");
		return;
	}
	const pending = metas
		.map((meta) => ({ meta, gate: computeGate(meta, listVerifications(ctx.cwd, meta.id)) }))
		.filter(({ gate }) => (targetId ? true : gate.state === "none" || gate.state === "stale"))
		.map(({ meta, gate }) => ({ id: meta.id, kind: meta.kind, state: gate.state }));
	if (!pending.length) {
		notify(ctx, ["No entity needs verification."], "Memory Verify");
		return;
	}
	actions.verify(pending);
	notify(ctx, [`Reminder injected for ${pending.length} entit${pending.length === 1 ? "y" : "ies"} — the agent will verify now.`], "Memory Verify");
}

/** 注册 /memory verify */
export function registerVerifyCommand(pi: ExtensionAPI, actions: SettlerActions): void {
	pi.registerCommand("memory verify", {
		description: "Remind the agent to verify unverified/stale entities (optional entity id)",
		handler: (args, ctx) => verify(args, ctx, actions),
	});
}