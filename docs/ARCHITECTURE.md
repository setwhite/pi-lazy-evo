# 架构设计

## 定位

`.memory/` 实体记忆库的治理协议 + pi 扩展：

- **协议**（`extension/protocol/`）：实体与验证记录的格式、record/verify 操作手册，代理操作记忆库的唯一真相源；
- **扩展**（TypeScript）：`/memory` 命令入口 + 门控计算，**只读库、不写库**；
- **零工具注入**：扩展不注册专用工具，代理用通用工具（grep/read/write/bash）按手册操作 `.memory/`。
  工具集不被污染、prompt cache 不受影响、协议迭代无需扩展发版。

## 结构

```
extension/
├── index.ts       # 装配入口：Runtime（协议路径 + 派发通道 + 会话 cwd）+ 注册命令
├── commands.ts    # /memory 单一入口：子命令表（路由/帮助/补全单一数据源）
├── store.ts       # 存储域：布局 / 实体 / 验证记录（尽力解析 + 非法忽略）/ 全库配对
├── gate.ts        # 门控域：四态推导 / 依赖失效 / 待办筛选（纯计算，无 IO）
├── deps.ts        # 统一读库入口 gatedLibrary(cwd)
├── prompts.ts     # AgentTask 纯数据 + 主会话提示词组装
├── utils.ts       # 纯工具：frontmatter / 校验 / 文本提取 / 通知
└── protocol/      # 协议手册（代理执行契约）
```

依赖方向 `index → commands → {prompts, deps → {gate, store}} → utils`。

边界约定：

- **一切读库走 `deps.gatedLibrary`**，调用方不自行拼装；
- `commands` 只做"解析 → 调 store/gate/prompts → 通知"；
- **扩展不写库**：唯一的写动作是 `ensureMemoryDir` 预建目录骨架。实体与记录由代理按手册用通用
  `write` 工具直接落盘——这是"零工具注入"的推论，也是 `store.ts` 只有读侧 API 的原因；
- `gate` 保持纯计算（不碰 IO、不 spawn 进程），mtime 等外部能力由 `deps` 注入；
- `prompts` 是任务纯数据，不复述手册内容（规则以 `protocol/` 为唯一真相源）。

## 数据模型

实体 `entities/<id>.md` 与验证记录 `verifications/<id>/<日期>[-N].md` 的字段、编号与时间戳规则
以 `protocol/entities.md`、`protocol/verifications.md` 为准，代码不重复这些规则，
读取层只做"尽力解析 + 非法忽略"的严格读取（包裹引号会剥离）。

`validator` 是**透传字符串**：代码不校验取值、不参与门控、不做展示排序，只在手册里定义五级
证据独立度（`claim` / `quote` / `corroborate` / `recompute` / `falsify`）。因此换词表是纯协议变更，
旧值原样可读——这是"等级给人看、不给机器算"的落法。

**门控四态**（❓none / ✅passed / ⚠️failed / ⏳stale）每次由"最新记录 checked_at vs
正文 mtime vs depends-on 文件 mtime"实时推导，不落盘、无缓存文件；
3 秒容差（`GRACE_MS`）抵消粗粒度文件系统的时间戳取整。语义表见 protocol/verifications.md。

## 命令流

`/memory` 按参数第一词路由（pi 派发只匹配 `/` 后第一个词，多词命令名不可达）。
补全两级：子命令词 + 参数候选；pi 选中值整体替换参数串，因此参数候选 value 须带子命令词。

- `overview`：读库 → 门控 → 展示四态计数与待修正/待验清单（不注入）
- `record [note]`：`recordTask(note?)` → `injectTask` 注入主会话。**不抽取会话转录**——主会话代理即会话
  本身，素材已在它的上下文里，附注只用于限定范围
- `query [terms]`：注入全库索引（门控预计算），grep 与相关性判断交给代理自带工具
- `verify all` / `verify <id>`：清全库积压或单实体复验。`all` 是保留 id，`utils.validateId` 拒为实体名；
  裸命令只展示用法与待办摘要，不打参数不动库

`overview` 与裸 `verify` 共用 `queueLines()` 渲染待办（修正优先于验证，超长折叠为计数）。
扩展的职责边界始终是**把清单/索引算好注入，动作本身交给代理**。

## 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 工具集不污染、prompt cache 不受影响、协议迭代无需发版 |
| **扩展只读库、不写库** | 零工具注入的直接推论。曾经有过的写侧 API（`writeEntity` / `appendVerification`）生产零调用，只有测试在用——测试走生产不走的路径，掩盖过 `depends-on` 字段丢失这类缺陷 |
| **没有自动挡** | 自动挡的成本在 record worker：为"以后可能有用"的候选预付最贵的智能。而"写时判断不了价值"这个诊断的主语本来是模型——去掉 auto 后 record 全部由人发起，判断者换成知道自己要什么的人，问题不再结构性存在 |
| **价值判定与清理都归人** | 人发起 record、人决定删除（出库只有删文件一条路）。因此**不做 TTL / 自动过期 / 静默过滤**：机制藏记录是隐性的，人会误以为"记过却查不到"；显式删文件比自动屏蔽诚实 |
| **验证器按证据独立性命名列，不按工具名** | 判据：被验对象为假时这个机制会不会报错。工具命名（`code:` / `web-research`）混入贵重感，让"跑 grep 拿眼看"和"确定性退出码检查"共用一个标签；按独立度命名后等级与手段合一，不需要额外的 level / object / falsifier 字段 |
| **不做机械重放层**（曾设计实体 `check` 命令 + spawn） | 要破"扩展不执行验证器"这条纪律，而现存记录可重放率为 0（`code:` 全是描述不是命令），收益不确定。代码类实体的新鲜度继续由免费的 depends-on/mtime 门控承担 |
| grep 检索而非向量索引 | 库小、零依赖、无预计算 |
| 验证只追加不覆盖 | 可审计 |
| 门控实时计算、否决 state.json | 状态永远由实体+验证记录两个真相推出；早期缓存落盘实现被发现字段只写不读 |
| 断言编号不回填存量 | 批量迁移是纯债；修正/新增自然生效，failed 记录首行编号清单驱动修正 |
| 存量与新词表不做映射 | 旧工具名取值一律按最低级 `claim` 理解（手册一句话，零代码）。给存量发它没挣到的等级，比"全库看起来都没验证过"更糟 |
| 手册唯一真相源，提示词不复述 | 改手册即改行为，不用动代码；提示词短、省 token |
| query 门控预计算注入 | 死板计算留在扩展代码，代理只做语义判断 |
| 配置面为零 | 没有挡位、没有 worker 参数、没有 settings 命名空间——`MEMORY_DIR` 一个环境变量够用。扩展的可调面越小，行为越可预测 |
