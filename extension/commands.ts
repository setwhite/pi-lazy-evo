/**
 * /memory 命令入口：单一命令 + 参数第一词路由（pi 只匹配 `/` 后第一个词，多词命令名不可达）。
 * 子命令表是路由 / 帮助 / 补全的单一数据源；补全两级：子命令词 + 参数候选。
 * 所有子命令只做"解析 → 调 store/gate/prompts → 通知"，业务聚合在 gate。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, setMode, type MemoryMode } from "./config.ts";
import { selectPending, summarizeLibrary, toPending } from "./gate.ts";
import { ensureMemoryDir, listEntities } from "./store.ts";
import { gatedLibrary } from "./deps.ts";
import { injectTask, queryTask, recordTask, verifyTask, type QueryIndexEntry } from "./prompts.ts";
import { notify } from "./utils.ts";
import type { Runtime } from "./index.ts";

/** 子命令 handler 统一签名（展示类命令忽略 runtime） */
type SubHandler = (args: string, ctx: ExtensionCommandContext, runtime: Runtime) => Promise<void>;

/** 参数候选来源：静态列表（mode）或动态读库（verify 列实体 id） */
type ArgValues = string[] | ((runtime: Runtime) => string[]);

/** 子命令条目：路由键 + 帮助面板 + 补全候选 + handler（help 无 handler） */
interface SubcommandDef {
	name: string;
	hint: string;
	description: string;
	handler?: SubHandler;
	/** 参数候选；有值则子命令词完整后补全参数（value 须带子命令词，选中值整体替换参数串） */
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
		argValues: (runtime) => (runtime.cwd ? listEntities(runtime.cwd).map((e) => e.id) : []),
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

/** 注册 /memory 入口（子命令按参数第一词查表路由） */
export function registerMemoryCommands(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("memory", {
		description: "Memory library (subcommands: overview / record / query / verify / mode)",
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

/** /memory overview：挡位 + 四态分布 + 待修正/待验清单（只展示，不注入） */
async function overview(_args: string, ctx: ExtensionCommandContext, _runtime: Runtime): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const mode = config.mode;
	const gated = gatedLibrary(ctx.cwd);
	if (!gated.length) {
		const lines = [`Mode: ${mode}`, "Memory library is empty."];
		if (mode === "auto" && !config.autoModel) lines.push(AUTO_MODEL_HINT);
		notify(ctx, "Memory Overview", lines);
		return;
	}
	const { counts, pending, fix } = summarizeLibrary(gated);
	const lines = [
		`Mode: ${mode}`,
		`Entities ${gated.length} | passed ${counts.passed} / failed ${counts.failed} / unverified ${counts.none} / stale ${counts.stale}`,
	];
	if (fix.length) {
		lines.push(`Needs fix (${fix.length}): ${fix.map(({ id }) => id).join(", ")}`);
		lines.push("Run /memory verify — failed entities go through fix-then-reverify.");
	}
	if (pending.length) {
		lines.push(`Needs verification (${pending.length}): ${pending.map(({ id, state }) => `${id} (${state === "none" ? "unverified" : "stale"})`).join(", ")}`);
		lines.push("Run /memory verify for a batch check.");
	}
	if (mode === "auto" && !config.autoModel) lines.push(AUTO_MODEL_HINT);
	notify(ctx, "Memory Overview", lines);
}

/** /memory record [note]：派发记录任务（剩余参数作为附注素材） */
async function record(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	injectTask(runtime, recordTask(args.trim()));
	notify(ctx, "Memory Record", ["Reminder injected — the agent will record memory now."]);
}

/** /memory query [terms]：注入检索任务（附预计算门控索引） */
async function query(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	const gated = gatedLibrary(ctx.cwd);
	if (!gated.length) {
		notify(ctx, "Memory Query", ["Memory library is empty."]);
		return;
	}
	const index: QueryIndexEntry[] = gated.map(({ meta, gate }) => ({ id: meta.id, kind: meta.kind, state: gate.state, path: meta.path }));
	injectTask(runtime, queryTask(args.trim(), index));
	notify(ctx, "Memory Query", ["Reminder injected — the agent will search memory now."]);
}

/** /memory verify [id]：算出待验+待修正清单并派发验证任务（验证动作本身交给代理执行） */
async function verify(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	const targetId = args.trim();
	const all = gatedLibrary(ctx.cwd);
	if (!all.length) {
		notify(ctx, "Memory Verify", ["Memory library is empty."]);
		return;
	}
	const pending = selectPending(all, targetId);
	if (targetId && !pending.length) {
		notify(ctx, "Memory Verify", [`Entity not found: ${targetId}`]);
		return;
	}
	if (!pending.length) {
		notify(ctx, "Memory Verify", ["No entity needs verification."]);
		return;
	}
	injectTask(runtime, verifyTask(toPending(pending)));
	const unit = pending.length === 1 ? "entity" : "entities";
	notify(ctx, "Memory Verify", [`Reminder injected for ${pending.length} ${unit} — the agent will verify now.`]);
}

/** 模式含义（一行文案） */
const MODE_LABEL: Record<MemoryMode, string> = {
	auto: "commands + background record & verify",
	manual: "commands only",
};

/** 未配置 autoModel 的提醒（切 auto / overview 时提示） */
const AUTO_MODEL_HINT =
	"未配置 autoModel：auto 挡后台任务将用主会话模型，建议在全局 settings.json 的 pi-lazy-evo 命名空间配置便宜模型（provider / id / thinking）。";

/** /memory mode [auto|manual]：查看或切换挡位（只写全局 settings.json，不影响 prompt cache） */
async function mode(args: string, ctx: ExtensionCommandContext, _runtime: Runtime): Promise<void> {
	const wanted = args.trim().toLowerCase();
	const config = loadConfig(ctx.cwd);
	if (wanted !== "auto" && wanted !== "manual") {
		notify(ctx, "Memory Mode", [
			`Current mode: ${config.mode} (${MODE_LABEL[config.mode]}).`,
			"Usage: /memory mode [auto|manual]",
		]);
		return;
	}
	const ok = setMode(wanted);
	const lines = [ok ? `Mode switched to ${wanted} (${MODE_LABEL[wanted]}).` : `Failed to switch to ${wanted}.`];
	if (ok && wanted === "auto" && !config.autoModel) lines.push(AUTO_MODEL_HINT);
	notify(ctx, "Memory Mode", lines);
}