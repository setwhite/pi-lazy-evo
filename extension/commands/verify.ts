/**
 * /memory verify 验证扳机：算出待验清单（unverified/stale），
 * 注入提醒让 agent 亲自验证（扩展不跑任何检查）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NEEDS_VERIFICATION, gateLibrary, type PendingEntity } from "../gate.ts";
import { readLibrary } from "../store.ts";
import type { SettlerActions } from "../agents/settler/agent.ts";
import { notify } from "../tools/notify.ts";

/** /memory verify [id]：列出待验实体并注入验证提醒 */
async function verify(args: string, ctx: ExtensionCommandContext, actions: SettlerActions): Promise<void> {
	const targetId = args.trim();
	const all = gateLibrary(readLibrary(ctx.cwd));
	if (!all.length) {
		notify(ctx, "Memory Verify", ["Memory library is empty."]);
		return;
	}
	const selected = targetId ? all.filter((g) => g.meta.id === targetId) : all;
	if (targetId && !selected.length) {
		notify(ctx, "Memory Verify", [`Entity not found: ${targetId}`]);
		return;
	}
	// 指定 id 时复验其当前状态（含 passed/failed）；未指定时只挑待验（unverified/stale）
	const pending = targetId ? selected : selected.filter((g) => NEEDS_VERIFICATION.has(g.gate.state));
	if (!pending.length) {
		notify(ctx, "Memory Verify", ["No entity needs verification."]);
		return;
	}
	const list: PendingEntity[] = pending.map(({ meta, gate }) => ({ id: meta.id, kind: meta.kind, state: gate.state }));
	actions.verify(list);
	const unit = pending.length === 1 ? "entity" : "entities";
	notify(ctx, "Memory Verify", [`Reminder injected for ${pending.length} ${unit} — the agent will verify now.`]);
}

/** 注册 /memory verify */
export function registerVerifyCommand(pi: ExtensionAPI, actions: SettlerActions): void {
	pi.registerCommand("memory verify", {
		description: "Remind the agent to verify unverified/stale entities (optional entity id)",
		handler: (args, ctx) => verify(args, ctx, actions),
	});
}