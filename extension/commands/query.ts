/**
 * /memory query 检索扳机：派发检索任务（关键词可选），主会话代理按协议执行。
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MainRunner } from "../agents/main.ts";
import { queryTask } from "../agents/actions.ts";
import { notify } from "../tools/notify.ts";

/** /memory query：派发检索任务 */
async function query(args: string, ctx: ExtensionCommandContext, runner: MainRunner): Promise<void> {
	runner.run(queryTask(args.trim()));
	notify(ctx, "Memory Query", ["Reminder injected — the agent will search memory now."]);
}

/** 注册 /memory query */
export function registerQueryCommand(pi: ExtensionAPI, runner: MainRunner): void {
	pi.registerCommand("memory query", {
		description: "Remind the agent to search .memory (optional search terms)",
		handler: (args, ctx) => query(args, ctx, runner),
	});
}