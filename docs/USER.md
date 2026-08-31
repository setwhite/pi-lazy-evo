# 用户指南

`/memory` 是唯一入口，5 个子命令。命令只是扳机：读写与验证由代理按 `extension/protocol/` 手册执行，
扩展不注入专用工具、**也不写库**（代理用通用工具直接落盘）。输入 `/memory ` 自动弹出子命令候选，
裸 `/memory` 或 `/memory help` 显示帮助。

## 命令

| 命令 | 作用 |
|---|---|
| `/memory overview` | 四态分布、待修正/待验清单（只展示，不派任务） |
| `/memory record [note]` | 沉淀实体。素材就是代理当前会话；附注用于限定范围 |
| `/memory query [terms]` | grep 检索记忆库；无关键词则由代理从会话推断 |
| `/memory verify all` | 清全库积压：unverified/stale 验证 + failed 修正（先改正文再复验） |
| `/memory verify <id>` | 全量复验该实体（含 passed）；裸 `/memory verify` 只展示用法与待办清单，不动库 |
| `/memory help` | 显示命令帮助 |

## 谁判断价值：你

没有自动挡，也没有后台任务——**记忆库只在你动手时变化**。这带来一条分工：

- **什么值得留下**：由你判断。`/memory record` 这个动作本身就是一次价值声明，代理不替你猜
  "以后会不会用"，它只保证写进去的每条断言可核对。
- **库会不会变脏**：由你负责清理。**删除实体文件是唯一的出库方式**（扩展永不删除，也没有自动过期）。
  怀疑某条已经没用或已经错了，`/memory query` 找到它、`/memory verify <id>` 复核、或直接删文件。
- **代价**：库只会随你的使用增长。定期（比如攒到几十条时）跑一次 `/memory overview` 看积压清单，
  顺手 `/memory verify all` 清一轮。

## 门控四态

实体没有"信任"字段，信任由最新验证记录推导。每张实体按「最新记录 checked_at vs
正文修改时间与 depends-on 文件修改时间」得四态：

| 状态 | 含义 | 怎么用 |
|---|---|---|
| ✅ passed | 验证通过且正文与依赖都没改 | 当事实用 |
| ⚠️ failed | 验证失败 | 别用；verify 会先进修正流（改正文再复验），不对错误正文重复验证 |
| ❓ unverified | 从没验证过 | 先验再信 |
| ⏳ stale | 正文改过或 depends-on 代码文件在验证后改过，旧验证失效 | 先验再信 |

改正文不用删验证记录——记录只追加，时间戳规则自动把实体降为 stale。描述本仓库代码/配置
行为的实体可在 front-matter 声明 `depends-on`（仓库内相对路径）：代码一变，对应实体的
passed 自动降 stale，无需人工发现；失效实时推导，无缓存文件。

引用一条 `none/stale/failed` 的实体去影响当前决策前，先对它跑一次 `/memory verify <id>`。

## 验证记录

每次验证追加一条记录到 `verifications/<实体id>/` 子目录（按实体归位，同日多条自动加序号）：
front-matter 四字段（target / validator / checked_at / result），证据写在正文、必填；
failed 记录首行列无效断言编号，让修正有精确落点。记录只追加不覆盖，历史可审计。

`validator` 按**证据独立性**分五级（`claim` < `quote` < `corroborate` < `recompute` < `falsify`），
不按工具命名——"跑了个命令拿眼看输出"和"跑了个确定性退出码检查"不是同一级。判据与定级纪律见
`extension/protocol/verifications.md`。早期记录的工具名取值按最低级 `claim` 理解，不回填、不映射。

## 记忆库

`.memory/` 默认在当前工作目录（`MEMORY_DIR` 可覆盖），`entities/` 实体卡片 +
`verifications/` 验证流水账，默认不入 git、不随仓库分发。

## 安装

见 [README](../README.md)：`pi install npm:pi-lazy-evo`（全局）或 `pi install -l npm:pi-lazy-evo`（仅当前项目）。
