# 用户指南

`/memory` 是唯一入口，6 个子命令。命令只是扳机：读写与验证由代理按
`extension/protocol/` 手册执行，扩展不注入专用工具。输入 `/memory ` 自动弹出子命令候选，
裸 `/memory` 或 `/memory help` 显示帮助。

## 命令

| 命令 | 作用 |
|---|---|
| `/memory overview` | 挡位、四态分布、待验清单（只展示，不派任务） |
| `/memory record [note]` | 把近期长期结论写入记忆库；附注可限定范围 |
| `/memory query [terms]` | grep 检索记忆库；无关键词则由代理从会话推断 |
| `/memory verify [id]` | 核对实体：不带 id 只验 unverified/stale，带 id 全量复验该实体 |
| `/memory mode [auto\|manual]` | 查看或切换挡位 |
| `/memory help` | 显示命令帮助 |

## 挡位

- `manual`（默认）：只有手动 `/memory` 命令触碰记忆库
- `auto`：会话结束（turn_end）按 token 水位触发，后台便宜模型自动 record + verify

auto 配置在 `pi-lazy-evo` 命名空间（每次读取实时生效，改完即用）。分两个来源：
- **mode** 只存全局 `~/.pi/agent/settings.json`——用户偏好，不入库不随仓库分发；`/memory mode` 切换的就是它
- 其余字段全局与项目 `.pi/settings.json` 合并，项目覆盖全局

| 字段 | 默认 | 存放 | 说明 |
|---|---|---|---|
| `mode` | `manual` | 全局 | 运行挡位 |
| `autoWatermarkTokens` | 32000 | 全局/项目 | 会话新增 token 达此值触发一次，越小越勤 |
| `autoModel` | 缺省用主会话模型 | 全局/项目 | `provider` / `id` / `thinking`（默认 `low`） |
| `autoMaxTurns` | 16 | 全局/项目 | worker 轮数上限（提示词软约束；主进程存活时另有 10 分钟超时硬宠底） |
| `autoMemoTools` | read,grep,ls,bash,write,edit | 全局/项目 | record worker 工具白名单 |
| `autoVerifyTools` | 左列 + web_search,web_fetch | 全局/项目 | verify worker 工具白名单 |

```jsonc
// 全局 ~/.pi/agent/settings.json（mode 唯一存放处）
{"pi-lazy-evo": {
  "mode": "auto",
  "autoWatermarkTokens": 30000,
  "autoModel": {"provider": "openrouter", "id": "gpt-4o-mini", "thinking": "low"},
  "autoMaxTurns": 8
}}
```

白名单是**替换**语义：填了就按填的来，别漏 read/grep/write。联网验证依赖搜索 provider，
先 `/web-tools` 配好再开 auto。未配置 `autoModel` 时切 auto / 看 overview 会提示配置
（缺省将用主会话模型跑后台任务，注意成本）。全局 settings 路径可用 `PI_GLOBAL_SETTINGS_FILE`
覆盖（多用户隔离/测试）。

## 门控四态

实体没有"信任"字段，信任由最新验证记录推导。每张实体按「最新记录 checked_at vs
正文修改时间」得四态：

| 状态 | 含义 | 怎么用 |
|---|---|---|
| ✅ passed | 验证通过且正文未改 | 当事实用 |
| ⚠️ failed | 验证失败 | 别用，可复验 |
| ❓ unverified | 从没验证过 | 先验再信 |
| ⏳ stale | 正文改过，旧验证失效 | 先验再信 |

改正文不用删验证记录——记录只追加，时间戳规则自动把实体降为 stale。

## 验证记录

每次验证追加一条 `verifications/` 下的记录：front-matter 四字段（target / validator /
checked_at / result），证据写在正文、必填。记录只追加不覆盖，历史可审计。
验证器取值见 `extension/protocol/verifications.md`，代理按手册执行，用户不直接操作。

## 记忆库

`.memory/` 默认在当前工作目录（`MEMORY_DIR` 可覆盖），`entities/` 实体卡片 +
`verifications/` 验证流水账，默认不入 git、不随仓库分发。

## 安装

见 [README](../README.md)：`pi install npm:pi-lazy-evo`（全局）或 `pi install -l npm:pi-lazy-evo`（仅当前项目）。