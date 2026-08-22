/**
 * /memory query 检索扳机：提醒 agent 检索 .memory/（关键词可选）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SettlerActions } from "../agents/settler/agent.ts";
import { notify } from "./notify.ts";

/** /memory query：注入检索提醒 */
async function query(args: string, ctx: ExtensionCommandContext, actions: SettlerActions): Promise<void> {
	actions.query(args.trim());
	notify(ctx, ["Reminder injected — the agent will search memory now."], "Memory Query");
}

/** 注册 /memory query */
export function registerQueryCommand(pi: ExtensionAPI, actions: SettlerActions): void {
	pi.registerCommand("memory query", {
		description: "Remind the agent to search .memory (optional search terms)",
		handler: (args, ctx) => query(args, ctx, actions),
	});
}