# 开发指南

## 环境与命令

bun 运行时。提交前：

```bash
bun test            # 单元测试（按域拆分，全绿）
bun run typecheck   # tsc strict，零错误
```

测试通过 `MEMORY_DIR` 指向临时目录隔离，不触碰真实 `.memory/`。

## 目录职责

依赖方向 `index → {commands, auto} → {prompts, gate, store} → utils`：

- `utils.ts` 只放确定性小工具（frontmatter / 校验 / 文本提取 / 通知，无 IO 无业务）
- `store.ts` 存储域整体（布局 / 实体 / 验证记录 / 全库配对），读取层"尽力解析 + 非法忽略"
- `gate.ts` 门控域纯函数（单实体四态判定 / 批量门控 / 待验筛选 / 全库摘要）
- `prompts.ts` 任务纯数据（AgentTask）+ 组装注入；手动命令与 auto worker 共用同一任务语义
- `commands.ts` 只做"解析输入 → 调 gate/prompts → 通知"，业务聚合在 gate
- `auto.ts` 水位判定 + 串行编排 + spawn 子进程 + 库快照 diff
- settings 命名空间统一 `pi-lazy-evo`（`config.ts` 的 NAMESPACE，测试断言同步）

## 编码约定

中文注释、完整类型标注、函数 ≤50 行、单文件 ≤300 行、嵌套 ≤3 层、
位置参数 ≤3、命名常量代替魔法数字、条件分支优先用命名数据结构（映射表/枚举/数据类）代替。

## 新增子命令

所有子命令挂在唯一 `memory` 入口（pi 派发只匹配第一词）。新增 `/memory foo`：

1. 在 `commands.ts` 的 `SUBCOMMANDS` 表加一条：导出 `foo(args, ctx, runtime)`（统一签名，
   展示类命令忽略 runtime），写入同文件
2. 需参数补全时给 `argValues`（静态列表，或动态候选函数，如 verify 读库列实体 id）
3. 在 `tests/commands.test.ts` 加用例；`docs/USER.md` 补用法

需"读库→门控→注入"的命令参照 verify：
`readLibrary → gateLibrary → selectPending → verifyTask + injectTask → notify`。

## 协议手册

`protocol/*.md` 是代理执行契约，格式的唯一真相源。代码不重复这些规则（读取层只做
"尽力解析 + 非法忽略"），改格式时同步协议与 docs：

- 记格式 `entities.md`、记操作 `record.md`
- 验格式 `verifications.md`、验操作 `verify.md`
- 用户视角（命令/配置/状态表）`docs/USER.md`
- 设计动机 `docs/ARCHITECTURE.md`

测试不覆盖协议文本，靠 store 读取的严格性测试兜底（非法一律忽略）。

## 测试结构

| 文件 | 覆盖 |
|---|---|
| store.test.ts | 存储域：实体/验证记录读写、严格性、整库配对 |
| gate.test.ts | 门控聚合纯函数（含 3s 容差） |
| config.test.ts | settings.json 读写（pi-lazy-evo 命名空间） |
| commands.test.ts | 命令注册、路由、两级补全、注入（独立会话工厂） |
| prompts.test.ts | 素材抽取、任务纯数据、主会话/worker 提示词组装 |
| auto.test.ts | 触发判定、冲刷节流与尾部落盘、worker 参数组装、库快照 diff |

## 发布

```bash
# 1) package.json 升版本（npm 不允许覆盖已发布版本，升级后再打 tag）
# 2) 打 v* tag 触发 .github/workflows/npm-publish.yml
git tag v0.1.8 && git push origin v0.1.8
```

发布经 npm trusted publishing（OIDC）认证，无需 API token。两个精确匹配约束：
npm 页面的 workflow 文件名（`npm-publish.yml`）与 `package.json` 的 `repository.url`
必须与仓库一致，否则发布失败；workflow 跑测试与类型检查通过后 `npm publish`，
自动生成 provenance 来源证明。

发布内容由 `files` 白名单决定（extension + docs）：改文档后需发版，包内 `docs/`
与 npm 页面 README 才会更新。
