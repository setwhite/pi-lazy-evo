# 用户指南

`/memory` 单一入口 + 6 个子命令。命令只是扳机：读写与验证由代理按 `extension/protocol/`
手册执行，检索由代理用自带工具（grep/read）+ 扩展注入的预计算索引完成。
输入 `/memory ` 自动弹出子命令候选；裸 `/memory` 显示帮助。

## 命令

| 命令 | 作用 |
|---|---|
| `/memory overview` | 查看挡位、四态分布、待验清单（不注入代理） |
| `/memory record [note]` | 让代理把近期长期结论写入 `.memory/`；附注可限定范围 |
| `/memory query [terms]` | 让代理 grep 检索 `.memory/`；无关键词则从会话推断 |
| `/memory verify [id]` | 让代理核对实体：无 id 只验 unverified/stale，有 id 全量复验该实体 |
| `/memory mode [auto\|manual]` | 查看/切换挡位（写 settings.json） |

示例（overview）：

```
/memory overview
→ Memory Overview
  Mode: manual
  Entities 3 | passed 1 / failed 0 / unverified 1 / stale 1
  Needs verification (2): foo (unverified), bar (stale)
  Run /memory verify for a batch check.
```

## 挡位

- `manual`（默认）：只有手动 `/memory` 命令触碰记忆库。
- `auto`：后台便宜模型按 token 水位自动 record + verify。配置在
  `.pi/settings.json` 的 `pi-lazy-evo` 命名空间（全局 `~/.pi/agent/settings.json` 与项目合并，项目覆盖），
  每回合重新读取，改完即生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoWatermarkTokens` | 64000 | 会话新增 token 达此值触发一次，越小越勤 |
| `autoModel.provider` / `.id` | （无） | 后台便宜模型，缺省用主会话模型 |
| `autoModel.thinking` | `low` | 思考档（off/low/medium…） |
| `autoMaxTurns` | 12 | 单个 worker 轮数上限（成本保护） |
| `autoMemoTools` | read,grep,ls,bash,write,edit | record worker 工具白名单 |
| `autoVerifyTools` | 上表 + web_search,web_fetch | verify worker 工具白名单 |

```jsonc
{"pi-lazy-evo": {
  "mode": "auto",
  "autoWatermarkTokens": 30000,
  "autoModel": {"provider": "openrouter", "id": "gpt-4o-mini", "thinking": "low"},
  "autoMaxTurns": 8
}}
```

注意：工具白名单是**替换**语义，别漏 read/grep/write；验证 worker 的联网工具需先
`/web-tools` 配好搜索 provider。

## 门控四态

每张实体按"最新验证记录时间 vs 正文修改时间"得四态：

| 状态 | 含义 | 对待 |
|---|---|---|
| ✅ passed | 核对通过且正文未改 | 当事实用 |
| ⚠️ failed | 核对失败 | 别用，可复验 |
| ❓ unverified | 从没核过 | 慎用，关键依据先补验 |
| ⏳ stale | 正文改过，旧核对失效 | 先复验再信 |

正文更新无需删验证记录——时间戳规则自动降为 stale。

## 记忆库与 git

`.memory/` 在当前工作目录（`MEMORY_DIR` 环境变量可覆盖）：`entities/` 实体卡片 +
`verifications/` 只追加验证流水账。运行时数据不入 git（.gitignore 默认忽略）。

## 安装

软链到 `~/.pi/agent/extensions/pi-lazy-evo`（全局，所有项目生效）或项目
`.pi/extensions/pi-lazy-evo`（仅当前项目，如本仓库自用），指向本仓库 `extension/`，pi 自动加载。