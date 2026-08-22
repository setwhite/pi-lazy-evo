/**
 * /memory record 沉淀扳机：提醒 agent 把近期结论沉淀进 .memory/（增 + 改）。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SettlerActions } from "../agents/settler/agent.ts";
import { notify } from "./notify.ts";

/** /memory record：注入沉淀提醒 */
async function record(_args: string, ctx: ExtensionCommandContext, actions: SettlerActions): Promise<void> {
	actions.record();
	notify(ctx, ["Reminder injected — the agent will settle memory now."], "Memory Record");
}

/** 注册 /memory record */
export function registerRecordCommand(pi: ExtensionAPI, actions: SettlerActions): void {
	pi.registerCommand("memory record", {
		description: "Remind the agent to settle durable conclusions into .memory (create or update entities)",
		handler: (args, ctx) => record(args, ctx, actions),
	});
}