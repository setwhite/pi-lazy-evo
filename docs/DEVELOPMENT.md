# 开发指南

## 环境与命令

bun 运行时。提交前：

```bash
bun test            # 单元测试（按域拆分，全绿）
bun run typecheck   # tsc strict，零错误
```

测试通过 `MEMORY_DIR` 指向临时目录隔离，不触碰真实 `.memory/`。

## 目录职责

依赖方向与边界约定见 `docs/ARCHITECTURE.md`，此处只列开发要点：

- `utils.ts` 只放确定性小工具（frontmatter / 校验 / 文本提取 / 通知，无 IO 无业务）
- `store.ts` 存储域整体（含 pending.md 会话尾部暂存），读取层"尽力解析 + 非法忽略"
- `gate.ts` 门控域纯函数（无 IO），mtime 能力由 `deps.ts` 注入
- 一切读库入口统一走 `deps.ts` 的 `gatedLibrary(cwd)`，调用方不自行拼装
- `prompts.ts` 任务纯数据 + 组装注入；提示词不复述 protocol/ 手册内容
- `worker.ts` 子进程通道：`pi --mode json` 事件流 → WorkerFeed（单行活动文本）→ ActivityPanel（行集渲染）
- settings 命名空间统一 `pi-lazy-evo`（`config.ts` 的 NAMESPACE，测试断言同步）

## 编码约定

中文注释、完整类型标注、函数 ≤50 行、单文件 ≤300 行、嵌套 ≤3 层、
位置参数 ≤3、命名常量代替魔法数字、条件分支优先用命名数据结构（映射表/枚举/数据类）代替。

## 新增子命令

所有子命令挂在唯一 `memory` 入口（pi 派发只匹配第一词）。新增 `/memory foo`：

1. 在 `commands.ts` 的 `SUBCOMMANDS` 表加一条：导出 `foo(args, ctx, runtime)`（统一签名，展示类命令忽略 runtime）
2. 需参数补全时给 `argValues`（静态列表，或动态候选函数，如 verify 列 `all` + 读库实体 id）。
   参数关键字须同步 `utils.ts` 的 `RESERVED_IDS`（拒绝作实体 id，防命令与数据撞车）
3. 在 `tests/commands.test.ts` 加用例；`docs/USER.md` 补用法

需"读库→门控→注入"的命令参照 verify：`gatedLibrary → selectPending → verifyTask + injectTask → notify`。

## 协议手册

`protocol/*.md` 是代理执行契约，格式与操作规则的唯一真相源——代码与提示词都不复述，
改手册即改行为；改格式时同步 `docs/USER.md`（用户视角）与 `docs/ARCHITECTURE.md`（设计动机）。
测试不覆盖协议文本，靠 store 读取的严格性测试兜底（非法一律忽略）。

手册不写记忆库的具体路径（一律称“库根”，定义见 entities.md）：绝对路径只由两条通道的提示词
给出（`prompts.ts` 的 `rootLine`）——$MEMORY_DIR 覆盖时手册与真路径不会分家。

## 测试结构

| 文件 | 覆盖 |
|---|---|
| store.test.ts | 存储域：实体/验证记录读写、严格性、整库配对 |
| gate.test.ts | 门控聚合纯函数（3s 容差、四态推导、筛选与摘要） |
| deps.test.ts | 依赖失效纯推导（passed 后依赖变化降级、复验自愈） |
| config.test.ts | settings.json 读写（pi-lazy-evo 命名空间） |
| commands.test.ts | 命令注册、路由、两级补全、注入（独立会话工厂） |
| prompts.test.ts | 素材抽取、任务纯数据、两条通道提示词组装 |
| auto.test.ts | 触发判定、增量清单、波次并发、存量提醒、库快照 diff、钩子的宿主归属（worker 模式不参与） |
| worker.test.ts | worker 参数组装、事件流活动描述、活动面板行管理 |

## 发布

```bash
# package.json 升版本（npm 不允许覆盖已发布版本）后打 tag 触发 npm-publish.yml
git tag v0.3.0 && git push origin v0.3.0
```

经 npm trusted publishing（OIDC）认证，无需 token。npm 页面的 workflow 文件名
（`npm-publish.yml`）与 `package.json` 的 `repository.url` 必须与仓库一致，否则发布失败。
发布内容由 `files` 白名单决定（extension + docs），改文档后需发版才会同步 npm 页面。
