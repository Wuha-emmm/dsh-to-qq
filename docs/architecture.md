# 架构

## 数据流

```
QQ 客户端（大号 / 群成员）
   ⇕ 腾讯服务器
QQ 客户端（小号，已登录桌面端）
   ⇕ SnowLuma 注入 hook
SnowLuma  ── OneBot v11 ──▶  ws://127.0.0.1:3001   事件
                            http://127.0.0.1:3000  动作
   ⇕
dsh-to-qq（Host 插件）
   ├─ 接入     events / onebot：解码、去重、重连、回填
   ├─ 判权     policy：准入、档位、配额、队列、审批、暂停
   ├─ 上下文   context：场景键、增量缓冲、引用置顶、字数预算
   ├─ 记忆     memory：人设、印象、批量整理、卡面
   ├─ 档案     archive：SQLite、媒体、检索、保留清理
   ├─ 渲染     render：文字转图、记忆卡、日报（PowerShell + GDI+）
   ├─ 媒体     media：图片、语音、文件、合并转发、引用取图
   └─ 工具     tools：9 个模型工具
   ⇕ ctx.sessionController
DSH Agent（owner 会话 / guest 会话）
```

## 为什么走 sessionController

它是网页客户端用的同一条路径：`create / prompt / follow`。这样 QQ 消息就是一条真实的 `user/message`，会话出现在侧边栏、可被接管、队列与 steering 语义免费获得。

Host 插件能在进程内直接调用这些方法（已实测：`list`、`modelCatalog`、`inspect`、`resolveAgent`、`projections`、`follow`、`prompt`）。

## 上下文的二分

| 场景 | 上下文来源 | 上限 |
|---|---|---|
| owner 私聊 | DSH 会话自身历史 | 不设限，由 DSH compaction 管理 |
| 群聊 / guest | 桥接层缓冲（增量 + 引用） | 99 条 / 6000 字（可配） |

两套互不重复计费；桥接层对 owner 私聊不做截断。

## 媒体管线

| 输入 | 处理 |
|---|---|
| 图片 | 下载（≤8MB）→ 动图取 9 帧拼 3×3 → base64 进 prompt |
| 语音 | QQ 原生 `fetch_ptt_text`（异步推送、失败重试一次）→ 本地 provider → 外部命令 |
| 文件 | `url` / `base64` / `get_file` 三路下载到 `media/`，路径写进提示 |
| 合并转发 | 展开两层，40 条 / 4000 字预算，内含图片继续走图片管线 |
| 引用 | 缓冲区 → `get_msg` → 展开转发；转发的图片同样取回 |

## 权限由发送者决定

会话不携带权限，每条消息按 `sender_id` 判定档位（见 [permission-model.md](permission-model.md)）。群里即使是管理员，也只落 `owner-group`（只读）。

## 传输选择

事件走 WebSocket，动作走 HTTP：

- 省掉 universal socket 的 `echo` 关联
- 掉线不影响发消息
- token 用查询参数（浏览器式 WebSocket 不能带 Authorization 头）

## 存储

| 路径 | 内容 |
|---|---|
| `config.json` | 设置页写、Host 监听热应用 |
| `sessions.json` / `guests.json` | 场景 ↔ DSH 会话绑定 |
| `memory.json` | 记忆卡 + 运行统计 + 印象冷却 |
| `archive.db` | SQLite（`node:sqlite`，WAL）：消息、媒体定位、检索 |
| `media/` | 可选保存的图片与卡片底图 |

`archive.retentionDays` 到期后每 6 小时自动清理数据库行与媒体文件。

## 零依赖原则

profile 级插件解析不到 DSH 的 `@deepseek-ai/*` 包，因此本插件只用 Node 内置能力与 DSH 注入的服务。渲染用系统 GDI+ 子进程，不引入原生模块。

## 自检

`npm run smoke` 真调 `apply()`；`npm run rehearse` 跑端到端预演（解码 → 判权 → 上下文 → 卡片渲染 → 面板鉴权）。两者都不需要 QQ。
