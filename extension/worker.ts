/**
 * worker 子进程通道：spawn `pi --mode json`，stdout 事件流逐行解析为活动文本，
 * 经活动面板（ActivityPanel）实时呈现——自动任务前台可见。
 * 事件流只用于活动展示；成败仍以库快照 diff 为准（library.ts），退出码仅兜底报错。
 * non-detached + windowsHide：继承父控制台不弹窗；父进程退出后子进程写管道收 EPIPE
 * 随会话终止（前台语义：不留隐形孤儿 worker）。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "./prompts.ts";
import { buildWorkerPrompt } from "./prompts.ts";
import type { AutoModel, MemorySettings } from "./config.ts";
import type { WorkerKind } from "./library.ts";

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;

/** 组装子进程调用参数并落盘提示词文件（参数组装可测；spawn 由 runWorker 执行） */
export function buildWorkerArgs(input: { model?: AutoModel; tools: string[]; promptContent: string }): { command: string; args: string[]; promptFile: string; promptDir: string } {
	const promptDir = mkdtempSync(join(tmpdir(), "pi-lazy-evo-auto-"));
	const promptFile = join(promptDir, "worker.md");
	writeFileSync(promptFile, input.promptContent, "utf8");
	const args = ["--mode", "json", "--no-session"];
	if (input.model) {
		args.push("--model", `${input.model.provider}/${input.model.id}`);
		args.push("--thinking", input.model.thinking ?? "low");
	} else {
		args.push("--thinking", "low");
	}
	args.push("--tools", input.tools.join(","), "--append-system-prompt", promptFile);
	args.push("任务：请立即执行记忆库操作。");
	return { command: "pi", args, promptFile, promptDir };
}

// ---- 事件流 → 活动文本 ----

/** JSONL 事件的最小结构视口（只取描述活动所需字段） */
interface WorkerEvent {
	type?: string;
	toolName?: string;
	args?: Record<string, unknown>;
}

/** 活动行展示的参数键（按优先级取第一个字符串值） */
const TOOL_ARG_KEYS = ["file_path", "path", "pattern", "query", "command", "url"] as const;
/** 活动文本截断长度（面板行不折行） */
const TOOL_TEXT_MAX = 48;

function truncate(text: string): string {
	return text.length <= TOOL_TEXT_MAX ? text : `${text.slice(0, TOOL_TEXT_MAX - 1)}…`;
}

/** 参数摘要：路径留末两段（目录/文件名），其余压平空白截断 */
function briefValue(key: string, value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	if ((key === "file_path" || key === "path") && /[\\/]/.test(flat)) {
		return truncate(flat.split(/[\\/]+/).filter(Boolean).slice(-2).join("/"));
	}
	return truncate(flat);
}

function describeTool(event: WorkerEvent): string {
	const name = event.toolName ?? "tool";
	const args = event.args;
	if (!args) return name;
	for (const key of TOOL_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return `${name} ${briefValue(key, value)}`;
	}
	return name;
}

function parseEvent(line: string): WorkerEvent | null {
	const t = line.trim();
	if (!t.startsWith("{")) return null;
	try {
		return JSON.parse(t) as WorkerEvent;
	} catch {
		return null;
	}
}

/** 活动流描述器：消费 --mode json 的 JSONL 行，维护"第 N 轮 · 正在做什么"单行文本 */
export class WorkerFeed {
	private turns = 0;
	private action = "启动中";
	private last = "";

	/** 当前活动文本 */
	text(): string {
		return `第 ${Math.max(this.turns, 1)} 轮 · ${this.action}`;
	}

	/** 消费一行事件；活动有变化返回新文本，无变化（含无关/非法行）返回 null */
	consume(line: string): string | null {
		const event = parseEvent(line);
		if (!event?.type) return null;
		if (event.type === "turn_start") {
			this.turns += 1;
			this.action = "思考中";
		} else if (event.type === "tool_execution_start") {
			this.action = describeTool(event);
		} else {
			return null;
		}
		const text = this.text();
		if (text === this.last) return null;
		this.last = text;
		return text;
	}
}

// ---- 活动面板 ----

/** 活动面板：每个 worker 一行，任何变化全量推给宿主渲染回调（空行集 → undefined 清除） */
export class ActivityPanel {
	private readonly rows = new Map<string, string>();

	constructor(private readonly render: (lines: string[] | undefined) => void) {}

	set(rowId: string, text: string): void {
		this.rows.set(rowId, text);
		this.emit();
	}

	drop(rowId: string): void {
		if (this.rows.delete(rowId)) this.emit();
	}

	private emit(): void {
		const lines = [...this.rows].map(([id, text]) => `${id} ${text}`);
		this.render(lines.length > 0 ? lines : undefined);
	}
}

// ---- spawn ----

/** spawn 参数：命令 / 参数 / 工作目录 / 超时 */
interface SpawnInput {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
}

/**
 * 终止 worker 进程树：Windows 用 taskkill /T；其余平台按进程组 SIGKILL。
 * 失败静默：worker 靠提示词轮数约束自行收尾。
 */
function killWorkerTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		} catch {
			// taskkill 不可用或失败：放弃
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已退出
		}
	}
}

/** spawn pi 子进程（--mode json）：stdout 按行回调，stderr 丢弃；非零退出/超时 reject */
async function spawnWorker(input: SpawnInput, onLine: (line: string) => void): Promise<void> {
	const { command, args, cwd, timeoutMs } = input;
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		proc.unref();
		const timer = setTimeout(() => {
			if (proc.pid) killWorkerTree(proc.pid); // 主进程存活时的超时兜底
			reject(new Error("worker timed out"));
		}, timeoutMs);
		let buffer = "";
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(code === null ? "worker terminated externally" : `worker exited with code ${code}`));
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** worker 运行输入（纯值 + 面板，不持有 UI ctx） */
export interface WorkerRunInput {
	kind: WorkerKind;
	/** 面板行标识（record 或 "verify <实体id>"） */
	rowId: string;
	task: AgentTask;
	protocolDir: string;
	cwd: string;
	config: MemorySettings;
	panel: ActivityPanel;
}

/** 单任务 spawn（record / verify 共用）：拼提示词 → 子进程 → 事件流进面板行 → 清理临时目录 */
export async function runWorker({ kind, rowId, task, protocolDir, cwd, config, panel }: WorkerRunInput): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, cwd, config.autoMaxTurns);
	const tools = kind === "record" ? config.autoMemoTools : config.autoVerifyTools;
	const built = buildWorkerArgs({ model: config.autoModel, tools, promptContent });
	const feed = new WorkerFeed();
	panel.set(rowId, feed.text());
	try {
		await spawnWorker({ command: built.command, args: built.args, cwd, timeoutMs: WORKER_TIMEOUT_MS }, (line) => {
			const text = feed.consume(line);
			if (text) panel.set(rowId, text);
		});
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
		panel.drop(rowId);
	}
}
