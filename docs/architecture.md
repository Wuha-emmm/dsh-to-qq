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
   ├─ 接入     events / onebot：解码、去重、重连、回填；requests：把好友/入群申请转给管理员；cards：分享卡片解析
   ├─ 判权     policy：准入、档位、配额、队列、审批、暂停
   ├─ 上下文   context：场景键、增量缓冲、引用置顶、字数预算
   ├─ 记忆     memory：人设、印象、批量整理、卡面、敏感信息过滤
   ├─ 档案     archive：SQLite、媒体、检索、保留清理
   ├─ 渲染     render：文字转图、记忆卡、日报（PowerShell + GDI+）
   ├─ 媒体     media：图片、语音、文件、合并转发、引用取图
   ├─ 工具     tools：12 个模型工具
   └─ 用量     llm/cost：每轮 token、峰谷价与检索计费
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
| 网页 | `web_fetch` 由本插件提供的 provider 实现（`web.fetchProvider: browser-fetch`）：浏览器 UA + Referer、短链解析（b23.tv/t.cn/youtu.be…）、B站走公开 API（`x/web-interface/view`，可选 `x/v2/reply` 读热评）；本机与内网地址一律拒绝 |

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

## 上下文只发一次

早期实现每轮都重发记忆卡、表情清单、群规和整个群窗口；这些块进了会话就永久留在历史里，聊 20 轮等于把同样的内容存了 20 份。现在由 `src/context/injection.js` 按会话记账：

| 块 | 行为 |
|---|---|
| 记忆卡 | 文本哈希变化才重发（换人、改人设、记了新印象） |
| 表情清单 | 会话内发一次，库变化才更新 |
| 群规 | 会话内发一次 |
| 群上下文 | 只发上次之后的新消息；同一条不会重复 |

`qq_status` 会显示 `context last N chars (saved M)`，直接看到本轮省了多少。

实测（`node scripts/context-budget.mjs`，20 轮群聊、每轮 3 条新消息）：

```
average per turn: old 3424 chars, new 360 chars
saved: 89.5%
```

5 轮的短会话省 72.5%，会话越长收益越大。注意：真正的"系统层注入"DSH 目前没有开放给插件（`prompt` 只能追加 user 消息），所以这里用"只发一次"达到同样效果。

## 会话重建与续接

上下文只发一次解决了"重复"，但会话历史本身仍会线性增长（工具输出、长回复）。两道闸门：

| 机制 | 触发 | 保留什么 |
|---|---|---|
| 自动重建（默认关闭） | 绑定会话的事件体积 > `conversation.autoRebuildKb`（默认 0） | 解绑旧会话，下一条消息现场从 archive 取最近 14 条作「会话续接」 |
| `/重建` 命令 | 手动 | 同上 |

重建只写一个标记到 `rebuilds.json`，摘要**不存内存**：下一条消息到达时现场生成，所以重启、崩溃都不会丢续接。摘要不参与敏感词检查（旧群友的用词不该吞掉新消息），且它的行会先被标记为"已见"，群上下文窗口不会重复这 14 条。

识图会话是另一种情况：每次描述互相独立，所以每次同步开始/结束都会解绑，一批一换。

## 回复长度

`output.replyCharsOwner`（默认 400）与 `output.replyCharsGroup`（默认 300）作为固定块每会话提示一次；回复超过它（或 `imageThreshold`，取更小者）就渲染成图片发出。注意这**不省 token**——模型已经生成全文，图片按像素计费通常比文字更贵；省钱靠的是"让模型写短"这一半。

## 申请与卡片

OneBot 的 `request` 事件（加好友、入群、邀请进群）不进消息路径，由 `src/bridge/requests.js` 解码后编号，私聊发给所有管理员：

```
【好友申请 #3】昵称(QQ)
附言：…
回复 /同意 3 或 /拒绝 3（30 分钟内有效）
```

桥**从不自己批准**：只有管理员回复后才调用 `set_friend_add_request` / `set_group_add_request`。被 QQ 风控拦下的申请根本不会推给 OneBot，只能在客户端「过滤信息」里手动处理。

分享卡片（`json` / `xml` 段）由 `src/bridge/cards.js` 解析成标题 + 正文 + 来源 + 链接；邀请进群卡还带群名与群号。解析失败才退化成 `[卡片]`。

## 群内真正的 @

模型写 `@名字` 只是文字。`src/bridge/mentions.js` 把回复切成 text/at 段，名字来自 `get_group_member_list`（10 分钟缓存）与最近消息里的发送者；查不到的名字保留原文，绝不猜 QQ 号去 ping 陌生人。私聊不处理。

## 人设锚点与压缩

DSH 在上下文接近窗口上限时会自动压缩（默认 `thresholdRatio 0.8`、保留最近 16% 原文）。压缩会把"只发一次"的记忆卡、群规、表情清单折进摘要，而注入账本仍以为它们已发送——所以 `compaction/end` 事件会清掉该场景的账本，下一条消息重发全部锚点（约 800 字，一次性）。

## 好友与陌生人

非管理员的私聊按机器人好友列表区分：好友按 `member` 档回复（聊天、联网、记忆、表情，无本机读写），没加好友的走 `access.strangerPolicy`。好友列表 `get_friend_list` 每 30 分钟最多刷新一次。

## 用量与费用

每轮 `assistant/message.usage`（输入/输出/缓存命中）与 `web_search`/`web_fetch` 次数写进 `turns` 表；「用量」页签按天汇总并按峰谷价估算（工作日 9-12、14-18 为高峰，其余半价）。实测缓存命中约 97%，长历史的主要成本是输出 token。

## 站点账号（可选）

「登录」页签可以给 B站 / 小红书存一份 cookie：

| 站点 | 登录方式 |
|---|---|
| B站 / 小红书 | 打开一个**独立的 Edge/Chrome 窗口**（自己的 `browser-profile`，不碰你平时用的浏览器），在里面手动登录；后台通过 DevTools 协议（`Storage.getCookies`）读回 cookie 保存 |

扫码登录这条路 B站已经不对外提供，所以不再实现。cookie 仍可直接粘贴作为备用。B站用 `x/web-interface/nav` 校验登录态。

cookie 存在状态目录的 `accounts.json`（不写进 `config.json`，面板只回状态不回 cookie）。`fetch_page` 只对匹配域名附加 cookie（`bilibili.com/b23.tv/hdslb.com`、`xiaohongshu.com/xhslink.com/xhscdn.com`），其他站点不受影响。

## 用登录的账号写 B站

「登录」页签存下的 cookie 只有一个用途之外的第二个用途：`bilibili` 工具可以带着它**搜视频、开浏览器、发评论、发动态、上报观看记录**。

| 动作 | 接口 | 说明 |
|---|---|---|
| `search` | `x/web-interface/wbi/search/type`（WBI 签名） | 顺带在登录浏览器打开搜索页和第一条结果，浏览器历史里能看到 |
| `open` | DevTools `Target.createTarget` | 在你自己的登录窗口里打开页面 |
| `subtitle` | `x/player/wbi/v2` → 字幕 JSON | **读视频内容最省的一条**：有字幕（含 AI 字幕）就能拿到逐句文本 |
| `comment` | `x/v2/reply/add` + `csrf`（`bili_jct`） | 需要视频 aid；`mention` 传 uid 才会 @ 对人 |
| `dynamic` | `x/dynamic/feed/create/dyn`（WBI + csrf） | 纯文字动态 |
| `history` | `x/v2/history/report`（先取 cid） | 只上报，不保证进观看记录 |
| `watch` | 打开页面 + DevTools 驱动静音播放 12 秒 + 上报 | 真实播放才会让 B站 记观看历史（前提是账号开着「记录我的浏览历史」） |

WBI 签名：从 `nav` 取 `wbi_img` 两个 key，按固定置换表混成 32 位 key，再把参数排序拼接后 `md5(query + key)` 得到 `w_rid`。

@ 的真实规则：B站 只认**昵称完全匹配**，纯文本 `@呜哈` 会链到**同名用户**（实测确实链到了另一个叫「呜哈」的账号）。所以 `comment` 的 `mention` 参数要传 uid，工具先查 `x/space/wbi/acc/info` 拿到准确昵称再拼进正文，发完用评论的 `content.members` 核对指向的 mid。

字幕是**登录态专属**：同一个 `x/player/wbi/v2`，带 cookie 返回 8 条字幕轨，不带 cookie 返回 0 条；而弹幕（`x/v1/dm/list.so`）是公开的，匿名也能拿。所以"能拿弹幕拿不到字幕"不是视频没字幕，而是请求没带登录态。

字幕实测（登录态下）：道歉视频 60 句 / 709 字，游戏视频 337 句 / 2492 字；都是 `ai-zh` AI 字幕，可能有错字。没有字幕的视频这条路直接断。

实测：光是发评论（纯 API）不会打开页面，也不进任何记录；`x/v2/history` 一直是 0 条，即便在窗口里播放了 14 秒也没出现——最可能是账号设置里关掉了「记录我的浏览历史」，插件读不到那个开关。

读写拆开：`bilibili_read`（subtitle / info）对所有档位开放——字幕是公开数据，只是需要登录态；`bilibili`（search / open / comment / dynamic / history / watch）仍然只有管理员能用，因为它会以你的账号公开发言、改观看历史、在你的桌面弹窗口。

**只有管理员能用**（不在任何群的工具白名单里）。B站风控可能拒绝写入并回 `-412`，工具会把这个原始原因带回给模型，不做美化。

## 群日报的日期窗口

`group_digest` 与 `/日报` 都接受日期：`today`、`yesterday`、`daybefore`（前天/前日）、`YYYY-MM-DD`、`N天前`/`-N`（中文「今天/昨天/前天」也认）。窗口由 `dayRange()` 按北京时间算出 `[start, end)`，查询用 `since` 起点 + `time_unix < end` 过滤。

0.76 之前只读「今天 00:00 到现在」，所以在凌晨要「昨日日报」时，拿到的是当天刚过去几个小时的几十条，而不是前一天的完整数据（实测同一群：今天 121 条 / 昨天 1357 条）。

## 固定通知去重

「已放行 pwsh …」这类模板由桥自己发，不经过模型。长任务里审批多次触发时，同一句话会隔几分钟重复一次（实测那晚同一句发了 3 次：01:30:47、01:42:19、01:47:34，内容完全相同）。`src/bridge/notice.js` 按「场景 + 文本」记住上一条，10 分钟内相同就跳过；**模型自己的回复不参与过滤**，措辞不同的不算重复。

## 截图与正文不再重复

同一条信息走两个通道就会读两遍：`qq_send` 立即发图带说明，回合结束时正文又说一遍。实测那晚 12 次带文字的 `qq_send`，caption ≥40 字的 4 次全部与正文高度重复，而 ≤30 字的读起来就是图注。

现在的规则：

| 模型调用 | 行为 |
|---|---|
| `qq_send({ image })`（无文字） | **立即发送**，图作为证据 |
| `qq_send({ image, text })` | **入队**，回合末与正文合并成一条（`mergeText`：有正文用正文，没正文用 caption） |
| caption 超过 30 字 | 截断成 30 字 + 省略号，返回值提示“剩下的写进正文” |

合并时图片最多 4 张同一条，多余的与文件各自单独发。**失败路径会先把队列冲刷出去再报错**（图是已经产出的东西，不该丢，也不该留到下一轮变成“旧图”）；队列项带时间戳，超过 5 分钟的直接丢弃（`pruneQueue`），任何漏网的路径都不会把旧截图带进新回合。`qq_send` 现在同时写入档案，之前它发出的内容完全不入档。

**不允许绕路**：`pwsh` 里出现写类接口（`send_*` / `upload_*` / `set_*_add_request`，或任何 `:端口/send_` 路径）会被 guard 拒绝并提示改用 `qq_send`；读取类接口（`get_status` 等）不受影响。被拒次数记在 `qq_status` 的 `raw sends blocked` 一行。这是护栏，不是安全边界：拼接 URL 或脚本文件仍能绕过。这条是 08:00 那次“两张图”的根因：模型先 `upload_private_file`（已投递一次），再 `send_private_msg` 带同一文件（又投递一次），两个文件名不同、内容相同。

面板里发起的回合此前 `qq_send` 报 “not bound”：`sessionContext` 查不到时现在会按 `sessions.json` 的绑定反查场景并缓存，所以界面里也能正常发图。

## 看图先缩图

`read_image` 按像素计费。实测 QQ 会话 24 小时内读了 **57 张截图**，文字量只有 7 千字符，token 却占上下文增长的大头（1280×720 约 1.1–1.5k token，1316×2832 约 3k）。两项改动：

| 位置 | 行为 |
|---|---|
| `shrink_image` 工具 | 手动用：长边 >1280 时缩一份用于"只看版式"。**不是默认路径** |
| 入站 QQ 图片 | **不缩**：模型只在需要细节时才读图，缩了正好把细节丢掉 |
| 截图给用户 | 截完直接 `qq_send`，不读图、不写说明——他要的就是图 |

实测 1316×2832 → 595×1280，像素少了 4.9 倍。小字看不清时仍可读原图，提示里写明了这点。
