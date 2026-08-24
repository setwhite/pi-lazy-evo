/**
 * /memory record 沉淀扳机：派发沉淀任务（增 + 改），主会话代理按协议执行。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MainRunner } from "../agents/main.ts";
import { recordTask } from "../agents/actions.ts";
import { notify } from "../tools/notify.ts";

/** /memory record：派发沉淀任务 */
async function record(_args: string, ctx: ExtensionCommandContext, runner: MainRunner): Promise<void> {
	runner.run(recordTask());
	notify(ctx, "Memory Record", ["Reminder injected — the agent will settle memory now."]);
}

/** 注册 /memory record */
export function registerRecordCommand(pi: ExtensionAPI, runner: MainRunner): void {
	pi.registerCommand("memory record", {
		description: "Remind the agent to settle durable conclusions into .memory (create or update entities)",
		handler: (args, ctx) => record(args, ctx, runner),
	});
}