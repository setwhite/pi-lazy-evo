/**
 * /memory 命令入口：单一命令 + 参数第一词路由（pi 只匹配 `/` 后第一个词，多词命令名不可达）。
 * 子命令表是路由 / 帮助 / 补全的单一数据源；补全两级：子命令词 + 参数候选。
 * 所有子命令只做"解析 → 调 store/gate/prompts → 通知"，业务聚合在 gate。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, setMode, type MemoryMode } from "./config.ts";
import { selectPending, summarizeLibrary, toPending, type GatedEntity } from "./gate.ts";
import { clearPendingTail, collectTranscriptWithPending, ensureMemoryDir, hasPendingTail, listEntities } from "./store.ts";
import { gatedLibrary } from "./deps.ts";
import { injectTask, queryTask, recordTask, verifyTask, type QueryIndexEntry } from "./prompts.ts";
import { notify } from "./utils.ts";
import type { Runtime } from "./index.ts";

/** 子命令 handler 统一签名（展示类命令忽略 runtime） */
type SubHandler = (args: string, ctx: ExtensionCommandContext, runtime: Runtime) => Promise<void>;

/** 参数候选来源：静态列表（mode）或"关键字 + 动态读库"（verify：all + 实体 id） */
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

/** /memory verify 参数里"全量清账"的关键字（保留词，validateId 禁止实体用此 id） */
const VERIFY_ALL = "all";

/** 子命令表（单一数据源：路由 / 帮助 / 补全共用） */
const SUBCOMMANDS: SubcommandDef[] = [
	{ name: "overview", hint: "", description: "library overview & verification queue", handler: overview },
	{ name: "record", hint: "[note]", description: "record durable conclusions into the memory library", handler: record },
	{ name: "query", hint: "[terms]", description: "search memory", handler: query },
	{
		name: "verify",
		hint: `[${VERIFY_ALL}|id]`,
		description: "verify entities: all = whole queue, <id> = one entity",
		handler: verify,
		argValues: (runtime) => [VERIFY_ALL, ...(runtime.cwd ? listEntities(runtime.cwd).map((e) => e.id) : [])],
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
		lines.push("Run /memory verify all — failed entities go through fix-then-reverify.");
	}
	if (pending.length) {
		lines.push(`Needs verification (${pending.length}): ${pending.map(({ id, state }) => `${id} (${state === "none" ? "unverified" : "stale"})`).join(", ")}`);
		lines.push("Run /memory verify all for a batch check.");
	}
	if (mode === "auto" && !config.autoModel) lines.push(AUTO_MODEL_HINT);
	notify(ctx, "Memory Overview", lines);
}

/** /memory record [note]：派发记录任务（附注素材 + 未固化会话尾部，一并消费） */
async function record(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	// 消费语义与 auto 挡对齐：并入手柄在派发时；auto 中途切 manual 不会丢上一会话尾部
	const hadTail = hasPendingTail(ctx.cwd);
	injectTask(runtime, recordTask(collectTranscriptWithPending(ctx.cwd, args.trim())));
	clearPendingTail(ctx.cwd);
	const lines = ["Reminder injected — the agent will record memory now."];
	if (hadTail) lines.push("Merged unflushed tail from the previous session.");
	notify(ctx, "Memory Record", lines);
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

/** /memory verify all|<id>：全量清账或单实体复验，派发验证任务（验证动作本身交给代理执行）。
 * 裸命令不默认全量：展示用法 + 待办摘要，避免"不打参数就动整个库"的隐藏动作。 */
async function verify(args: string, ctx: ExtensionCommandContext, runtime: Runtime): Promise<void> {
	const target = args.trim();
	const all = gatedLibrary(ctx.cwd);
	if (!all.length) {
		notify(ctx, "Memory Verify", ["Memory library is empty."]);
		return;
	}
	if (!target) {
		notify(ctx, "Memory Verify", usageLines(all));
		return;
	}
	const gated = target === VERIFY_ALL ? selectPending(all) : selectPending(all, target);
	if (!gated.length) {
		notify(ctx, "Memory Verify", [target === VERIFY_ALL ? "No entity needs verification." : `Entity not found: ${target}`]);
		return;
	}
	injectTask(runtime, verifyTask(toPending(gated)));
	const unit = gated.length === 1 ? "entity" : "entities";
	notify(ctx, "Memory Verify", [`Reminder injected for ${gated.length} ${unit} — the agent will verify now.`]);
}

/** 用法 + 待办摘要（裸 verify 展示；id 清单超长时截断） */
function usageLines(all: GatedEntity[]): string[] {
	const { pending, fix } = summarizeLibrary(all);
	const queue = [...fix, ...pending];
	const shown = queue.map(({ id }) => id);
	const more = shown.length > QUEUE_PREVIEW_MAX ? shown.slice(0, QUEUE_PREVIEW_MAX).concat(`… +${shown.length - QUEUE_PREVIEW_MAX}`) : shown;
	return [
		`Usage: /memory verify ${VERIFY_ALL} — clear the whole queue (fix + verify)`,
		"       /memory verify <id> — (re)verify one entity",
		queue.length ? `Queue (${queue.length}): ${more.join(", ")}` : "Queue is empty: nothing needs verification.",
	];
}

/** 裸 verify 待办清单预览上限（超出折叠为计数） */
const QUEUE_PREVIEW_MAX = 10;

/** 模式含义（一行文案） */
const MODE_LABEL: Record<MemoryMode, string> = {
	auto: "commands + auto record & verify (live activity panel)",
	manual: "commands only",
};

/** 未配置 autoModel 的提醒（切 auto / overview 时提示） */
const AUTO_MODEL_HINT =
	"autoModel not configured: auto tasks will use the main session model. Recommended: configure a cheap model (provider / id / thinking) under the pi-lazy-evo namespace in global settings.json.";

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