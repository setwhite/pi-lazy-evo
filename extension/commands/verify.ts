/**
 * /memory verify 验证扳机：算出待验清单（unverified/stale）派发验证任务，
 * 主会话代理按协议亲自验证（扩展不跑任何检查）。
 * 待验筛选由 gate.selectPending 纯函数承担；自动挡验证复用同一清单逻辑。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gateLibrary, selectPending, toPending, type PendingEntity } from "../core/gate.ts";
import { readLibrary } from "../core/store.ts";
import type { MainRunner } from "../agents/main.ts";
import { verifyTask } from "../agents/actions.ts";
import { notify } from "../tools/notify.ts";

/** /memory verify [id]：列出待验实体并派发验证任务 */
async function verify(args: string, ctx: ExtensionCommandContext, runner: MainRunner): Promise<void> {
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
	const list: PendingEntity[] = toPending(pending);
	runner.run(verifyTask(list));
	const unit = pending.length === 1 ? "entity" : "entities";
	notify(ctx, "Memory Verify", [`Reminder injected for ${pending.length} ${unit} — the agent will verify now.`]);
}

/** 注册 /memory verify */
export function registerVerifyCommand(pi: ExtensionAPI, runner: MainRunner): void {
	pi.registerCommand("memory verify", {
		description: "Remind the agent to verify unverified/stale entities (optional entity id)",
		handler: (args, ctx) => verify(args, ctx, runner),
	});
}