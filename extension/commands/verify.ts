/**
 * /memory verify 验证扳机：算出待验清单（unverified/stale），
 * 注入提醒让 agent 亲自验证（扩展不跑任何检查）。
 * 待验筛选由 gate.selectPending 纯函数承担，命令只做 IO → 门控 → 注入。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gateLibrary, selectPending, type PendingEntity } from "../core/gate.ts";
import { readLibrary } from "../core/store.ts";
import type { SettlerActions } from "../agents/settler/agent.ts";
import { notify } from "../tools/notify.ts";

/** /memory verify [id]：列出待验实体并注入验证提醒 */
async function verify(args: string, ctx: ExtensionCommandContext, actions: SettlerActions): Promise<void> {
	const targetId = args.trim();
	const all = gateLibrary(readLibrary(ctx.cwd));
	const pending = selectPending(all, targetId);
	if (targetId && !pending.length) {
		notify(ctx, "Memory Verify", [`Entity not found: ${targetId}`]);
		return;
	}
	if (!all.length) {
		notify(ctx, "Memory Verify", ["Memory library is empty."]);
		return;
	}
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
