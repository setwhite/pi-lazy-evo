/**
 * /memory query 子命令：扩展算好全库索引（门控态预计算）注入检索任务。
 * grep 与相关性判断由主会话代理用自带工具执行（扩展不造检索轮子）；
 * 门控是死板计算，交给扩展代码，代理不重算。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { gateLibrary } from "../core/gate.ts";
import { readLibrary } from "../core/store.ts";
import type { Runtime } from "../index.ts";
import { queryTask, type QueryIndexEntry } from "../prompts/tasks.ts";
import { injectTask } from "../prompts/build.ts";
import { notify } from "../tools/notify.ts";

/** /memory query [terms]：注入检索任务（附预计算门控索引） */
export async function query(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	const gated = gateLibrary(readLibrary(ctx.cwd));
	if (!gated.length) {
		notify(ctx, "Memory Query", ["Memory library is empty."]);
		return;
	}
	const index: QueryIndexEntry[] = gated.map(({ meta, gate }) => ({
		id: meta.id,
		kind: meta.kind,
		state: gate.state,
		path: meta.path,
	}));
	injectTask(runtime, queryTask(args.trim(), index));
	notify(ctx, "Memory Query", ["Reminder injected — the agent will search memory now."]);
}
