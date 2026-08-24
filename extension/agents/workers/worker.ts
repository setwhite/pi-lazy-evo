/**
 * 子进程通道：任务 → 提示词 → spawn 独立 pi 子进程执行（auto 挡用）。
 * 沉淀/验证共用此通道；任务语义在 agents/actions.ts，提示词在 agents/prompts.ts。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoModel, MemorySettings } from "../../core/config.ts";
import { notify } from "../../tools/notify.ts";
import type { AgentTask } from "../actions.ts";
import { buildWorkerPrompt } from "../prompts.ts";

/** worker 默认超时（毫秒）：防子进程卡死 */
const WORKER_TIMEOUT_MS = 10 * 60_000;

/** 组装子进程调用参数与提示词内容（纯函数，可测；spawn 由调用方执行） */
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
	args.push("Task: 请执行上述后台任务。");
	return { command: "pi", args, promptFile, promptDir };
}

/** 跑一个后台任务：拼提示词 → spawn → 通知结果 → 清理临时目录 */
export async function runWorkerTask(kind: string, task: AgentTask, protocolDir: string, ctx: ExtensionContext, config: MemorySettings, tools: string[]): Promise<void> {
	const promptContent = buildWorkerPrompt(task, protocolDir, ctx.cwd, config.autoMaxTurns);
	const built = buildAutoWorkerArgs({ model: config.autoModel, tools, promptContent });
	try {
		const summary = await spawnWorker(built.command, built.args, ctx.cwd, WORKER_TIMEOUT_MS);
		const model = config.autoModel ? config.autoModel.id : "主模型";
		notify(ctx, `Memory Auto·${kind}（${model}）`, [summary]);
	} catch (error) {
		notify(ctx, `Memory Auto·${kind} 失败`, [error instanceof Error ? error.message : String(error)]);
	} finally {
		rmSync(built.promptDir, { recursive: true, force: true });
	}
}

/** spawn pi 子进程（headless），收集输出返回最终 assistant 文本 */
async function spawnWorker(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		let lastAssistant = "";
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
						const text = messageText(event.message.content).trim();
						if (text) lastAssistant = text;
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
			if (code === 0) {
				resolve(lastAssistant || "已执行（无文本输出）");
			} else {
				reject(new Error(`worker 退出码 ${code}${stderr ? `：${stderr.slice(0, 200)}` : ""}`));
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** 消息 content 提取纯文本（兼容字符串与 block 数组） */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
			.map((b) => (typeof b.text === "string" ? b.text : ""))
			.join("");
	}
	return "";
}