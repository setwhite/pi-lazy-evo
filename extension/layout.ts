/**
 * 存储布局：记忆库根目录定位与目录骨架创建。
 * entities/ 与 verifications/ 两个子域共享此处，避免重复定位逻辑。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 记忆库根目录：优先 $MEMORY_DIR，其次 <cwd>/.memory（环境变量可覆盖，供测试隔离） */
export function memoryDir(cwd: string): string {
	return process.env.MEMORY_DIR ?? join(cwd, ".memory");
}

/** 根系目录存在性检查，缺失则创建 entities/verifications 骨架 */
export function ensureMemoryDir(cwd: string): string {
	const dir = memoryDir(cwd);
	for (const sub of ["", "entities", "verifications"]) {
		const p = join(dir, sub);
		if (!existsSync(p)) mkdirSync(p, { recursive: true });
	}
	return dir;
}
