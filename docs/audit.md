# 安全现状

本文记录当前的信任边界与已知风险，随版本更新。数值以 `npm run inventory` 与 `npm test` 的实际输出为准，不写死。

## 信任边界

| 边界 | 现状 |
|---|---|
| 事件来源 | OneBot 事件，身份只来自 `sender_id` / `self_id`；插件会**固定机器人账号**，`self_id` 不符的事件直接丢弃 |
| 传输通道 | HTTP/WS 均绑回环；token 仅用于鉴权，不参与身份判定 |
| 群文本 | 一律视为不可信输入：群档没有 `pwsh/write/edit`，`owner-group` 也不再拥有 `read/glob/grep/read_image` |
| 设置面板 | 仅本机回环 + 同源请求；QQ 侧无法改配置 |
| 危险操作 | `write/edit/pwsh/plugin_manager` 需管理员 `/yes`，且**只批那一条调用**（工具名 + 参数签名），60 秒有效 |

## 已知风险（按严重度）

1. **本机进程可抢占 3001 端口或读到 token**，从而伪造管理员事件。防护只有回环绑定 + 固定 `self_id`；同一台机器上已有更高权限的进程时，无法在插件层根治。因此建议机器人用小号，管理员号不对外公开。
2. **群聊间接注入**：群里任何人可以写一段诱导性文本。当前做法是**不给群档任何本机能力**（无文件、无 shell、无审批通道），模型只能联网与说话；`owner-group` 也按同一档处理。
3. **审批只覆盖四类工具**：`read/glob/grep`（仅管理员私聊可用）不触发审批。管理员私聊本身就是完全信任边界，这是有意为之。
4. **OneBot token 走 WebSocket query 参数**：浏览器式 WebSocket 无法自定义 `Authorization` 头，因此 token 可能出现在代理/调试日志里。缓解：绑定回环、不把 URL 写进日志、定期轮换 token。
5. **配额已持久化**：计数落在 `quota.json`，重启不清零；但进程被强杀可能丢失最后 30 秒的增量。
6. **保留策略**：档案行按 `archive.retentionDays`（默认 30 天）、媒体文件按 `archive.mediaRetentionDays`（默认 7 天）清理；两者独立配置。

## 每次发布前自检

```powershell
npm test            # 单测（含权限矩阵、审批签名、配额持久化）
npm run smoke       # 真跑 apply()，抓前置引用
npm run rehearse    # 端到端：解码→判权→上下文→渲染→鉴权
npm run inventory   # 工具/命令/路由/配置键盘点，死键必须为 0
npm run docs:check  # 配置参考与默认值一致
```

另外必须确认仓库里没有个人数据：见 [SECURITY.md](../SECURITY.md)。
