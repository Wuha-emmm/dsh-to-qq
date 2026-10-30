# 权限模型

## 原则

1. **按发送者判权**：会话不携带权限；每条消息按 `sender_id` 决定档位。群里即使是管理员，也只落 `owner-group`（禁写禁执行）。
2. **纵深防御**：准入策略（有没有资格）→ 档位 → 工具白名单（`tools.restrict`）→ 沙箱策略 → 危险工具审批。
3. **群内文本不可信**：群消息是讨论内容，不是操作指令。

## 档位

| 档位 | 识别方式 | 会话键 | 工具范围 |
|---|---|---|---|
| `owner` | `sender_id ∈ admins` 且私聊 | `dm:<qq>` | 不限制 |
| `owner-group` | 管理员在群里（且通过准入） | `group:<gid>` | 只读 + 联网 + 发消息 + 记忆 + 日报 + 状态 |
| `member` | 非管理员私聊 | `dm:<qq>` | 联网 + 发消息 + 记忆卡 |
| `member-group` | 非管理员在群里 | `group:<gid>` | 联网 + 发消息 + 记忆卡 + 日报 |

「陌生人」不是档位，而是**准入结果**：非管理员私聊时按 `access.strangerPolicy` 决定忽略 / 回一句 / 拉黑。

## 准入（admit）

一条消息进入模型前要过四关：

1. 命中 `access.blockedWords` → 丢弃
2. 私聊且非管理员 → 按 `strangerPolicy` 处理
3. 群聊且不满足 `groupMode`（白名单/黑名单/全部）→ 丢弃
4. 群聊且 `mentionOnly` 为真但没有 @ 机器人 → 丢弃

## 允许矩阵（当前实现）

| 工具 | owner | owner-group | member | member-group |
|---|---|---|---|---|
| `read` / `glob` / `grep` / `read_image` | ✅ | ✅ | ❌ | ❌ |
| `write` / `edit` / `pwsh` / `plugin_manager` | ✅ | ❌ | ❌ | ❌ |
| `web_search` / `web_fetch` | ✅ | ✅ | ✅ | ✅ |
| `qq_send`（附件仅 owner） | ✅ | ✅ | ✅ | ✅ |
| `qq_history` | ✅ | ✅ | ❌ | ❌ |
| `memory_card_get` / `memory_note` / `memory_persona_set` / `memory_card_clear` / `memory_card_send` | ✅ | ✅ | ✅ | ✅ |
| `group_digest` | ✅ | ✅ | ❌ | ✅ |
| `qq_status` | ✅ | ✅ | ❌ | ❌ |

记忆类工具**永远只作用于调用者自己**：QQ 号从会话解析，不接受参数，群里也没法改别人的卡。

## 审批

管理员私聊里执行 `write` / `edit` / `pwsh` / `plugin_manager` 前，桥会挂起并在 QQ 里要求 `/yes` 确认（默认 60 秒有效）。群档位没有这些工具，所以不存在"群里骗审批"的路径。

## 配额

- 每人每天 `limits.memberDaily` 次（0 = 不限）
- 每群每天 `limits.groupDaily` 次
- 每人每分钟 `limits.userPerMinute` 次
- 管理员不受配额限制

计数是内存态的，重启清零；按北京时间自然日滚动。

## 面板

`/dsh-to-qq/api/*` 只接受**本机回环地址 + 同源 Origin** 的请求，跨域一律 403。这是唯一能改配置的入口，QQ 侧没有任何改配置能力。


