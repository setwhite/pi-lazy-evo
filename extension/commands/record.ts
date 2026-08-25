/**
 * /memory record 子命令：派发记录任务（增 + 改），主会话代理按协议执行。
 * 剩余参数作为附注素材注入提示词，便于指定记录范围。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../index.ts";
import { recordTask } from "../prompts/tasks.ts";
import { injectTask } from "../prompts/build.ts";
import { notify } from "../tools/notify.ts";

/** /memory record [note]：派发记录任务 */
export async function record(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	injectTask(runtime, recordTask(args.trim()));
	notify(ctx, "Memory Record", ["Reminder injected — the agent will record memory now."]);
}
