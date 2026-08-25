/**
 * 子进程通道：任务 → 提示词 → spawn 独立 pi 子进程执行（auto 挡用）。
 * record/verify 共用此通道；任务语义在 prompts/tasks.ts，提示词在 prompts/build.ts。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoModel, MemorySettings } from "../core/config.ts";
import { notify } from "../tools/notify.ts";
import { listEntities, listVerifications } from "../core/store.ts";
import type { AgentTask } from "../prompts/tasks.ts";
import { buildWorkerPrompt } from "../prompts/build.ts";
import { messageText } from "../tools/text.ts";

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;

/** worker 任务类型：record 只写实体，verify 只追加验证记录 */
export type WorkerKind = "record" | "verify";

/** 库快照：实体 id→mtime + 验证记录文件名→(target,result)，供 worker 前后 diff */
export interface LibrarySnapshot {
	entityMtimes: Map<string, number>;
	verifications: Map<string, { target: string; result: "passed" | "failed" }>;
}

/** 变化摘要：实体新增/更新 + 新增验证记录 */
export interface LibraryChanges {
	addedEntities: string[];
	updatedEntities: string[];
	newVerifications: { id: string; result: "passed" | "failed" }[];
}

/** 快照当前库：实体 mtime + 验证记录文件（纯 IO，无副作用） */
export function snapshotLibrary(cwd: string): LibrarySnapshot {
	return {
		entityMtimes: new Map(listEntities(cwd).map((m) => [m.id, m.mtimeMs])),
		verifications: new Map(listVerifications(cwd).map((v) => [basename(v.path), { target: v.target, result: v.result }])),
	};
}

/** 前后快照对比：实体新增/更新 + 新增验证记录（实体删除不报） */
export function diffLibrary(before: LibrarySnapshot, after: LibrarySnapshot): LibraryChanges {
	const addedEntities = [...after.entityMtimes.keys()].filter((id) => !before.entityMtimes.has(id));
	const updatedEntities = [...after.entityMtimes.entries()]
		.filter(([id, mtime]) => {
			const prev = before.entityMtimes.get(id);
			return prev !== undefined && prev !== mtime;
		})
		.map(([id]) => id);
	const newVerifications = [...after.verifications.entries()]
		.filter(([file]) => !before.verifications.has(file))
		.map(([, v]) => ({ id: v.target.replace(/^entities\//, "").replace(/\.md$/, ""), result: v.result }));
	return { addedEntities, updatedEntities, newVerifications };
}

/** 通知文案策略表：kind → 格式化函数（无变化统一返回 "无变化"） */
const FORMATTERS: Record<WorkerKind, (changes: LibraryChanges) => string> = {
	record: (c) => {
		const parts: string[] = [];
		if (c.addedEntities.length) parts.push(`+ ${c.addedEntities.join(", ")}`);
		if (c.updatedEntities.length) parts.push(`~ ${c.updatedEntities.join(", ")}`);
		return parts.length ? parts.join("　") : "无变化";
	},
	verify: (c) => {
		if (!c.newVerifications.length) return "无变化";
		const list = c.newVerifications.map((v) => `${v.id} ${v.result === "passed" ? "✅" : "⚠️"}`).join(", ");
		return `+ 验证：${list}`;
	},
};

/** 变化清单 → 一行通知文本 */
export function formatChanges(kind: WorkerKind, changes: LibraryChanges): string {
	return FORMATTERS[kind](changes);
}

/** 组装子进程调用参数并落盘提示词文件（参数组装可测；spawn 由调用方执行） */
export function buildAutoWorkerArgs(input: { model?: AutoModel; tools: string[]; promptContent: string }): { command: string; args: string[]; promptFile: string; promptDir: string } {
	const promptDir = mkdtempSync(join(tmpdir(), "lazy-memory-auto-"));
	const promptFile = join(promptDir, "worker.md");
	writeFileSync(promptFile, input.promptContent, "utf8");
	const args = ["--mode", "json", "-p", "--no-session"];
	if (input.model) {
		args.push("--model", `${input.model.provider}/${input.model.id}`);
		args.push("--thinking", input.model.thinking ?? "low");
	} else {
		args.push("--thinking", "low");
	}
	args.push("--tools", input.tools.join(","), "--append-system-prompt", promptFile);
	args.push("任务：请执行上述后台任务。");
	return { command: "pi", args, promptFile, promptDir };
}

/** 跑一个后台任务：拼提示词 → 快照 → spawn → diff 通知 → 清理临时目录 */
export async function runWorkerTask(kind: WorkerKind, task: AgentTask, protocolDir: string, ctx: ExtensionContext, config: MemorySettings, tools: string[]): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, ctx.cwd, config.autoMaxTurns);
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		const before = snapshotLibrary(ctx.cwd);
		await spawnWorker({ command: built.command, args: built.args, cwd: ctx.cwd, timeoutMs: WORKER_TIMEOUT_MS, maxTurns: config.autoMaxTurns });
		const changes = diffLibrary(before, snapshotLibrary(ctx.cwd));
		const model = config.autoModel ? config.autoModel.id : "主模型";
		notify(ctx, `Memory Auto·${kind}（${model}）`, [formatChanges(kind, changes)]);
	} catch (error) {
		notify(ctx, `Memory Auto·${kind} 失败`, [error instanceof Error ? error.message : String(error)]);
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
	}
}

/** spawn 参数（内部）：命令/参数/工作目录/超时/轮数上限 */
interface SpawnInput {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxTurns: number;
}

/** spawn pi 子进程（headless），收集输出返回最终 assistant 文本。
 * 轮数上限是硬约束：数 assistant message_end 事件，达到 maxTurns 立即收工。 */
async function spawnWorker(input: SpawnInput): Promise<string> {
	const { command, args, cwd, timeoutMs, maxTurns } = input;
	return await new Promise<string>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let lastAssistant = "";
		let assistantTurns = 0;
		let hitLimit = false;
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("worker 超时"));
		}, timeoutMs);
		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
					if (event.type === "message_end" && event.message?.role === "assistant") {
						assistantTurns++;
						const text = messageText(event.message.content).trim();
						if (text) lastAssistant = text;
						if (assistantTurns >= maxTurns) {
							hitLimit = true;
							proc.kill("SIGKILL"); // 轮数上限：硬约束，不再给子进程开口机会
						}
					}
				} catch {
					// 非 JSON 行忽略（如日志）
				}
			}
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`worker 退出码 ${code}${stderr ? `：${stderr.slice(0, 200)}` : ""}`));
				return;
			}
			const fallback = hitLimit ? "已达轮数上限（无文本输出）" : "已执行（无文本输出）";
			resolve(lastAssistant || fallback);
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
