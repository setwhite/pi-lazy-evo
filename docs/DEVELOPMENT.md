# 开发指南

面向 lazy-memory 扩展源码的贡献者。协议手册（`extension/protocol/`）是代理执行契约，
本文是**代码**的开发约定。

## 环境与命令

- 运行时：bun（扩展是 bun 环境加载的 TS 模块；用 bun 安装/执行，不用 npm/pip）
- 单元测试：`bun test`（`extension/` 下执行，按域拆分）
- 类型检查：`bunx tsc -p .tsconfig.json`（strict，零错误要求）
- 记忆库隔离：测试通过 `MEMORY_DIR` 环境变量指向临时目录，绝不触碰真实 `.memory/`

提交前至少跑：

```bash
cd extension
bun test      # 期望全绿
bunx tsc -p .tsconfig.json   # 期望零错误
```

## 编码约定

- 注释、文档一律中文（专业术语除外），保持简洁
- 类、函数、数据类字段必须带完整类型标注
- 函数体 ≤ 50 行，单文件 ≤ 300 行，超则拆模块
- 控制流嵌套 ≤ 3 层；函数位置参数 ≤ 3 个，超则改用对象/结构体
- 条件分支过多优先用命名数据结构（映射表/枚举/数据类）代替
- 用命名常量代替魔法数字（0/1/-1 等公认语义除外）

## 分层依赖规则

- `core/gate.ts` 是**纯计算**：只 import `store` 的类型，不做任何 IO；
  新增门控/统计逻辑放 gate，方便无 IO 单测
- `core/store.ts` 是对外 barrel：内部实现按域拆分到 `entities` / `verifications` / `layout`，
  新增存储字段/子域时保持 barrel 导出入口稳定
- `commands/` 只做"解析输入 → 调 core/agent → 通知"，不内联业务计算；
  需要聚合时优先在 gate 提纯函数（如 `summarizeLibrary` / `selectPending`）
- `agents/settler/` 是命令执行层（动作 = 拼提示词 → dispatch）；
  auto 自动挡不走 dispatch，另起独立子进程按协议直读——见下节

## 数据格式约束

- 实体 front-matter 恰好三字段（id/kind/sources），id 小写连字符、kind 五选一；
  无合法 front-matter 或缺失 id/kind 的文件不入库（严格模式）
- 验证记录五字段（target/validator/checked_at/result/evidence），
  target 精确 `entities/<id>.md`、checked_at 完整 ISO；
  非法 result 或无法定时刻的记录被丢弃（不伪装成 passed）
- 验证记录只追加、不覆盖：写新文件，同日同名用 `-2`/`-3` 序号避让

## 新增一个 /memory 命令

以新增 `/memory foo` 为例，改四处：

1. **命令扳机**：新建 `extension/commands/foo.ts`
   ```ts
   export function registerFooCommand(pi: ExtensionAPI, ...deps): void {
     pi.registerCommand("memory foo", { description: "...", handler: handler });
   }
   ```
   只做参数解析 + 通知；业务聚合提纯到 gate，执行动作复用 settler。
2. **注册**：在 `extension/commands/index.ts` 的 `registerMemoryCommands` 里追加调用。
3. **测试**：在 `extension/tests/commands.test.ts` 会话桩里加用例（临时库 + pi 桩）。
4. **文档**：在 `docs/USER.md` 补命令用法。

若命令需要"读库→门控→注入"，参照 `/memory verify` 的模式：
`readLibrary`（IO）→ `gateLibrary`（纯算）→ `selectPending`（纯筛）→ `actions.verify` → `notify`。

## 扩展点：auto 自动模式（已实现）

`hooks/auto.ts` 挂 turn_end 时钟 + token 水位。与初稿不同，auto **不复用**
`createSettlerActions`（那是主会话假入），而是 spawn 独立 pi 子进程（便宜模型、
独立上下文、自带通用工具）按 `protocol/` 手册操作 `.memory/`——与手动模式同一套哲学：
扩展不代写库，worker 是“又一个按协议执行的代理”。

触发判定是纯函数 `decideAutoTrigger`（吸收基线 / compaction 回落 / 增量达阈值 / 防并发），
提示词与 spawn 参数组装也是纯函数，可无 IO 单测；真实 spawn 是薄壳。
串行跑：先沉淀 worker（带素材，record）后验证 worker（无素材，verify）。

改动链路：`config.ts` 加 auto 配置项 → `hooks/auto.ts` 组装 spawn → `index.ts` 挂钩子 →
`commands/mode.ts` 文案 → 文档。调阈值/模型在 `.pi/settings.json` 的 `lazy-memory` 命名空间。

## 测试结构

- `tests/store.test.ts`：存储域（实体/验证记录读写、严格性、整库配对）
- `tests/gate.test.ts`：门控与聚合纯函数（构造 meta/record，不 IO）
- `tests/config.test.ts`：settings.json 读写（临时 cwd 隔离）
- `tests/commands.test.ts`：命令注册与注入（每用例独立会话：临时库 + pi 桩）

`commands.test.ts` 的 `createSession()` 是隔离会话工厂：独立临时库、独立 pi 桩、
独立命令注册表，用例间零状态共享、顺序无关。
