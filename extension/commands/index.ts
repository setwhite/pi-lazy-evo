/**
 * 命令注册入口：单一 /memory 入口 + args 子命令路由（overview/record/query/verify/mode）。
 * pi 的派发只匹配 `/` 后第一个词（SDK agent-session 源码），多词命令名永远不可达，
 * 因此只注册一个 "memory" 命令，按参数第一词路由；裸 /memory 显示帮助而非总览。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../index.ts";
import { ensureMemoryDir } from "../core/layout.ts";
import { listEntities } from "../core/store.ts";
import { notify } from "../tools/notify.ts";
import { overview } from "./overview.ts";
import { record } from "./record.ts";
import { query } from "./query.ts";
import { verify } from "./verify.ts";
import { mode } from "./mode.ts";

/** 子命令 handler：统一签名（注入类 handler 用 runtime，展示类忽略） */
type SubHandler = (args: string, ctx: ExtensionCommandContext, runtime: Runtime) => Promise<void>;

/** 参数候选来源：静态列表（mode）或动态读取（verify 读库列实体 id） */
type ArgValues = string[] | ((runtime: Runtime) => string[]);

/** 子命令条目：路由键 + 帮助面板 + 补全候选 + handler（help 无 handler） */
interface SubcommandDef {
	name: string;
	hint: string;
	description: string;
	handler?: SubHandler;
	/** 参数候选（如 mode 的 auto/manual）；有值则子命令词完整后补全参数 */
	argValues?: ArgValues;
}

/** 子命令表（单一数据源：路由 / 帮助 / 补全共用） */
const SUBCOMMANDS: SubcommandDef[] = [
	{ name: "overview", hint: "", description: "library overview & verification queue", handler: overview },
	{ name: "record", hint: "[note]", description: "record durable conclusions into .memory", handler: record },
	{ name: "query", hint: "[terms]", description: "search memory", handler: query },
	{
		name: "verify",
		hint: "[id]",
		description: "verify unverified/stale entities",
		handler: verify,
		argValues: (runtime) => (runtime.cwd ? listEntities(runtime.cwd).map((m) => m.id) : []),
	},
	{ name: "mode", hint: "[auto|manual]", description: "show or switch mode", handler: mode, argValues: ["auto", "manual"] },
	{ name: "help", hint: "", description: "show this help" },
];

/** 帮助面板（裸 /memory、/memory help、未知子命令时展示） */
function help(ctx: ExtensionCommandContext): void {
	notify(ctx, "Memory", [
		"Subcommands:",
		...SUBCOMMANDS.map((s) => `  /memory ${s.name}${s.hint ? ` ${s.hint}` : ""} — ${s.description}`),
	]);
}

/** 注册 /memory 入口（子命令按 args 第一词查表路由） */
export function registerMemoryCommands(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("memory", {
		description: "Memory library (subcommands: overview / record / query / verify / mode)",
		/** 两级补全：/memory <子命令前缀> 给子命令候选；子命令词完整且有 argValues 时给参数候选。
		 *  pi 传的 prefix 是 /memory 后的完整参数串，选中项 value 会整体替换该串，
		 *  因此参数候选的 value 必须带子命令词（如 "mode auto"）。 */
		getArgumentCompletions: (prefix: string) => {
			const [word, ...rest] = prefix.split(/\s+/);
			const def = SUBCOMMANDS.find((s) => s.name === word);
			if (def) {
				const values = typeof def.argValues === "function" ? def.argValues(runtime) : def.argValues;
				if (!values?.length) return null;
				const tail = rest.join(" ");
				const items = values.filter((v) => v.startsWith(tail)).map((v) => ({ value: `${def.name} ${v}`, label: v }));
				return items.length ? items : null;
			}
			const items = SUBCOMMANDS.filter((s) => s.name.startsWith(word)).map((s) => ({
				value: s.name,
				label: s.hint ? `${s.name} ${s.hint}` : s.name,
				description: s.description,
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			ensureMemoryDir(ctx.cwd); // 目录骨架由扩展负责，代理只管读写文件
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts.shift() ?? "";
			const def = SUBCOMMANDS.find((s) => s.name === sub);
			if (def?.handler) {
				await def.handler(parts.join(" "), ctx, runtime);
				return;
			}
			if (!def && sub !== "") notify(ctx, "Memory", [`Unknown subcommand: ${sub}`]);
			help(ctx);
		},
	});
}
