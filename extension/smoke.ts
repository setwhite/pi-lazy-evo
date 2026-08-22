/**
 * 冒烟测试（临时 MEMORY_DIR，不触碰真实库）：
 * 1. 模块加载与 schema 构建
 * 2. store：实体列出/写入/验证记录追加（同日多条序号）
 * 3. gate：四态判定（passed/none/stale）
 * 4. settings：模式读写
 */
import { mkdtempSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMemoryDir, writeEntity, appendVerification, listEntities, listVerifications } from "./store.ts";
import { computeGate } from "./gate.ts";
import { registerMemoryCommands } from "./commands/index.ts";
import { Runtime } from "./runtime.ts";
import { loadConfig, setMode } from "./config.ts";
import { createPrompts } from "./agents/settler/prompts.ts";

// 临时记忆库
process.env.MEMORY_DIR = mkdtempSync(join(tmpdir(), "lazy-memory-test-"));
const TMP = process.env.MEMORY_DIR;

// 预置一个已证实实体（验证记录晚于实体）与一个未验证实体
ensureMemoryDir(process.cwd());
writeEntity(process.cwd(), { id: "test-tool", kind: "tool", sources: "smoke test", assertions: ["CLI tool supports plugin extension.", "Docs live in the docs directory."] });
await new Promise((r) => setTimeout(r, 1100)); // 保证 mtime 与验证时间错开
appendVerification(process.cwd(), { entityId: "test-tool", validator: "code: echo ok", result: "passed", evidence: "smoke" });
appendVerification(process.cwd(), { entityId: "test-tool", validator: "user-confirm", result: "passed", evidence: "smoke2" });
writeEntity(process.cwd(), { id: "test-idea", kind: "concept", sources: "smoke test", assertions: ["A concept description."] });

// gate
const metas = listEntities(process.cwd());
const gateTool = computeGate(metas.find((m) => m.id === "test-tool")!, listVerifications(process.cwd(), "test-tool"));
const gateIdea = computeGate(metas.find((m) => m.id === "test-idea")!, listVerifications(process.cwd(), "test-idea"));
console.log("gate1 verified expects passed:", gateTool.state === "passed", gateTool.state);
console.log("gate2 unverified expects none:", gateIdea.state === "none", gateIdea.state);

// 同日多条验证记录文件名序号
const files = readdirSync(join(TMP, "verifications"));
console.log("same-day suffix expects >=2 files:", files.filter((f) => f.includes("test-tool")).length >= 2, files.join(","));

// stale：改实体后旧记录应降级（写入时刻必须比最新验证晚 GRACE_MS(3s) 以上）
await new Promise((r) => setTimeout(r, 3500));
writeEntity(process.cwd(), { id: "test-tool", kind: "tool", sources: "smoke test 2", assertions: ["CLI tool supports plugin extension.", "Docs live in the docs directory.", "Added assertion."] });
const gateStale = computeGate(listEntities(process.cwd()).find((m) => m.id === "test-tool")!, listVerifications(process.cwd(), "test-tool"));
console.log("gate3 after edit expects stale:", gateStale.state === "stale", gateStale.state);

// appendVerification 序号递增：再追加一条应生成 -3
appendVerification(process.cwd(), { entityId: "test-tool", validator: "user-confirm", result: "passed", evidence: "smoke3" });
const filesAfter = readdirSync(join(TMP, "verifications")).filter((f) => f.includes("test-tool"));
console.log("3rd same-day record gets -3 suffix:", filesAfter.some((f) => f.endsWith("-3.md")), filesAfter.join(","));

// 命令注册（注册调用不抛错）
const piStub = { registerTool: () => {}, registerCommand: () => {} } as never;
registerMemoryCommands(piStub as never, new Runtime(piStub as never));
console.log("command registration ok");

// 模式设置读写（独立临时 cwd，避免污染真实 settings.json）
const tmpCwd = mkdtempSync(join(tmpdir(), "lazy-memory-mode-"));
mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
console.log("mode default expects manual:", loadConfig(tmpCwd).mode === "manual");
console.log("mode set+read auto:", setMode(tmpCwd, "auto") && loadConfig(tmpCwd).mode === "auto");
console.log("mode back to manual:", setMode(tmpCwd, "manual") && loadConfig(tmpCwd).mode === "manual");

// 引用的提示词函数可构建（不抛错）：协议路径注入后生成完整指令
const prompts = createPrompts(join(TMP, "PROTOCOL.md"));
console.log("prompts built ok:", prompts.record().length > 0, prompts.query("pi").length > 0, prompts.verify([{ id: "pi", kind: "tool", state: "none" }]).length > 0);

console.log("SMOKE PASS");