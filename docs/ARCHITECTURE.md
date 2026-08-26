# 架构设计

## 定位

`.memory/` 实体记忆库的治理协议 + pi 扩展：

- **协议**（`extension/protocol/`）：实体与验证记录的格式、record/verify 操作手册，
  是代理操作记忆库的唯一真相源；
- **扩展**（TypeScript）：`/memory` 命令入口、门控计算、挡位与 auto worker；
- **零工具注入**：扩展不注册专用工具，代理用通用工具（grep/read/write/bash）按手册
  操作 `.memory/`。工具集不被污染、prompt cache 不受影响、协议迭代无需扩展发版。

## 目录结构

```
extension/
├── index.ts         # 装配入口：Runtime（协议路径 + dispatch + 会话 cwd）+ 注册命令 + auto 钩子
├── commands.ts      # 单一 /memory 入口：子命令表（路由/帮助/补全单一数据源）+ 6 个子命令
├── auto.ts          # auto 挡：turn_end 水位判定 + 串行编排 + spawn worker 子进程 + 快照 diff
├── prompts.ts       # 代理任务纯数据（AgentTask）+ 提示词组装注入（主会话/worker 共用）
├── store.ts         # 存储域：布局 / 实体 / 验证记录 / 全库配对
├── gate.ts          # 门控域：单实体四态判定 / 批量门控 / 待验筛选 / 全库摘要
├── config.ts        # settings 命名空间读写（pi-lazy-evo）
├── utils.ts         # 纯工具：frontmatter / 校验 / 文本提取 / 通知
├── tests/           # bun:test 单元测试（按域拆分）
└── protocol/        # 协议手册（代理执行契约）
```

依赖方向 `index → {commands, auto} → {prompts, gate, store} → utils`；utils 最底层
（纯工具，无 IO 无业务），store 不依赖上层。

模块边界：

- `commands.ts` 只做"解析输入 → 调 gate/prompts → 通知"，业务聚合在 gate；
- `prompts.ts` 是任务纯数据（要代理干什么）+ 组装注入，
  手动命令（主会话）与 auto worker（子进程）共用同一套任务语义；
- `auto.ts` 只做触发编排（水位判定 → 串行双任务）与子进程通道，任务语义来自 prompts；
- `store.ts` 一个文件承载存储域（布局 / 实体 / 验证记录 / 全库配对），读取层"尽力解析 + 非法忽略"。

## 数据模型

```
.memory/
├── entities/          # 实体：一个文件一张
└── verifications/     # 验证流水账：一次一条，只追加
```

**实体**（`entities/<id>.md`）：front-matter 恰好 id / kind / sources 三字段；
正文每句一个可验证断言。文件名即 id，信任不放在正文里。

**验证记录**（`verifications/<日期>-<id>.md`，日期只防重名，门控不读文件名）：
front-matter 恰好 target / validator / checked_at / result 四字段，证据写在正文（必填）。

字段取值与校验规则以 `extension/protocol/entities.md` / `verifications.md` 为准，
代码不重复这些规则，只做"尽力解析 + 非法忽略"的严格读取。

**门控四态**：取实体最新验证记录（checked_at 最大），对比正文 mtime：

| 条件 | 状态 |
|---|---|
| 无任何记录 | ❓ none |
| 最新记录 passed 且晚于正文修改 | ✅ passed |
| 最新记录 failed 且晚于正文修改 | ⚠️ failed |
| 最新记录早于正文修改（超容差） | ⏳ stale |

3 秒容差（`GRACE_MS`）抵消粗粒度文件系统（容器挂载 / SMB / FAT32）的时间戳取整。
门控不落盘、每次实时计算；格式非法的实体与记录一律忽略（front-matter 损坏、id/kind
缺失、target 不精确匹配、checked_at 非完整 ISO、result 非法）。

## 命令流

`/memory` 按参数第一词路由（pi 只匹配 `/` 后第一个词，多词命令名不可达）。
补全两级：子命令词 + 参数候选（mode 静态列表，verify 动态读库列实体 id）。
pi 传的补全 prefix 是 `/memory` 后完整参数串、选中值整体替换，因此参数候选的
value 必须带子命令词（如 `mode auto`）。

- `overview`：读库 → 门控 → 四态计数 + 待验清单，只展示不注入
- `record [note]`：注入记录任务（note 作为附注素材），代理自行完成读协议 → 检索 → 写入
- `query [terms]`：扩展算好全库索引（门控态预计算）注入，grep 与相关性判断靠代理自带工具
- `verify [id]`：读库 → 门控 → `selectPending`（无 id 只选 none/stale，有 id 全量复验）→ 注入清单
- `mode [auto|manual]`：读写全局 settings.json 的 `pi-lazy-evo` 命名空间（mode 只存全局、不随仓库分发），不改任何模型可见面

手动命令与 auto 挡共用注入链路：`selectPending → verifyTask / recordTask → injectTask`。
职责边界：`/memory verify` 只把清单算好注入，验证动作本身交给代理执行。

## auto 挡

挂在 `turn_end` 事件上：水位判定（纯函数）→ 串行派发 record、verify 两个后台任务。

**水位判定**（`decideAutoTrigger`）：会话累计 token 与基线之差达到 `autoWatermarkTokens`
触发一次。三个防循环规则：

- 首次观察只吸收基线，不触发
- token 回落（compaction）重设基线，不触发
- worker 在跑（inFlight）时吸收增量，结束后不重复触发

**worker 子进程**：任务提示词写入临时文件，spawn 独立 `pi --mode json -p --no-session`
子进程，`--tools` 传白名单、`--model` 传便宜模型（缺省主模型）、`--thinking low`；
10 分钟超时杀进程；轮数上限 `autoMaxTurns` 是硬约束——数 assistant message_end 事件，
到限立即 SIGKILL，不给子进程开口机会。

**结果通知**：worker 前后各拍一次库快照（实体 id→mtime + 验证记录文件名→target/result），
diff 后一行通知：record 报 `+ 新增 / ~ 更新`，verify 报 `+ 验证：<id> ✅/⚠️`。

## 设计决策

| 决策 | 理由 |
|---|---|
| 零工具注入 | 工具集不污染、prompt cache 不受影响、协议迭代无需发版 |
| grep 检索而非向量索引 | 库小、零依赖、无预计算 |
| 验证只追加不覆盖 | 可审计 |
| 门控实时计算 | 状态永远由实体 + 验证记录两个唯一真相推出 |
| 任务语义两条通道共用 | 手动与 auto 同一套 AgentTask，改动只在一处 |
| query 门控预计算注入 | 死板计算留在扩展代码，代理只做语义判断 |
| 模式切换只写全局 settings.json | mode 是用户偏好：不入库、不随仓库分发、不被 git 覆盖；工具集/提示词不变，切换不影响 prompt cache |

## pi 行为事实（SDK 源码验证）

- 命令派发只匹配 `/` 后第一个词 → 单一 memory 入口 + args 路由；
- Tab 不触发命令补全，候选自动弹出；补全 prefix 是 `/memory` 后完整参数串，
  选中值整体替换该串（参数候选 value 须带子命令词，如 `mode auto`）；
- 扩展发现：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目，信任后加载），
  支持符号链接。