# 开发指南

## 环境与命令

bun 运行时。提交前：

```bash
cd extension
bun test            # 单元测试（按域拆分，全绿）
bun run typecheck   # tsc strict，零错误
```

测试通过 `MEMORY_DIR` 指向临时目录隔离，不触碰真实 `.memory/`。

## 编码约定

中文注释、完整类型标注、函数 ≤50 行、单文件 ≤300 行、嵌套 ≤3 层、
位置参数 ≤3、命名常量代替魔法数字、条件分支优先用命名数据结构（映射表/枚举/数据类）代替。

本项目补充：

- `tools/` 只放确定性小工具（无 IO 无业务）；整体逻辑在 core
- `core/store.ts` 是 barrel，存储子域在 entities / verifications / layout
- `prompts/tasks.ts` 任务纯数据 + `build.ts` 组装注入；手动命令与 auto worker 共用同一任务语义
- `commands/` 只做"解析输入 → 调 core/prompts → 通知"，业务聚合提纯到 gate
- settings 命名空间统一用 `pi-lazy-evo`（`core/config.ts` 的 NAMESPACE），测试断言同步

## 新增子命令

所有子命令挂在唯一 `memory` 入口（pi 派发只匹配第一词）。新增 `/memory foo`：

1. 新建 `commands/foo.ts`：导出 `foo(args, ctx, runtime)`（统一签名，展示类命令忽略 runtime）
2. 在 `commands/index.ts` 的 `SUBCOMMANDS` 表加一条（含 handler）；需参数补全时给 `argValues`
   （静态列表，或动态候选函数，如 verify 读库列实体 id）
3. 在 `tests/commands.test.ts` 加用例；`docs/USER.md` 补用法

需"读库→门控→注入"的命令参照 verify：
`readLibrary → gateLibrary → selectPending → verifyTask + injectTask → notify`。

## 测试结构

| 文件 | 覆盖 |
|---|---|
| store.test.ts | 存储域：实体/验证记录读写、严格性、整库配对 |
| gate.test.ts | 门控聚合纯函数 |
| config.test.ts | settings.json 读写（pi-lazy-evo 命名空间） |
| commands.test.ts | 命令注册、路由、两级补全、注入（独立会话工厂） |
| subagents.test.ts | auto 判定、素材抽取、提示词组装、库快照 diff |