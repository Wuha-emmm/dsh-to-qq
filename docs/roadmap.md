# 路线

| 版本 | 内容 | 估时 | 状态 |
|---|---|---|---|
| v0.0.1 | 仓库骨架、配置存储、OneBot 传输、设计文档 | 0.5d | 完成 |
| v0.1 | 接入层：事件解码、去重、白名单、回声 | 1d | 完成（实测双向通过） |
| v0.2 | DSH 会话驱动：场景映射、prompt/follow、超时与重绑 | 1.5d | 完成（实测通过） |
| v0.3 | 群聊：上下文注入、历史回填、agent 作用域限制 | 2d | 完成（实测通过） |
| v0.6 | 记忆卡：按 QQ 的笔记与人设、四个工具、注入 | 1.5d | 完成（含印象批量整理） |
| v0.5 | 三档权限（含群聊只读） | 1.5d | 完成 |
| v0.9 | 档案、图片管线、转图、悬浮窗、设置页 | 5d | 完成 |
| v1.0 | 审批数字回复、会话遥控、一键暂停、主动提醒 | 1.5d | 部分：`/yes` 审批、`/列表 /切换 /新建 /暂停` 完成；主动提醒未做 |
| v1.1 | 文件双向（inbox/outbox）、表情包库、记忆卡可视化 | 3d | 部分：出站文件可发、记忆卡可视化完成；入站文件仍只有 `[文件]` 占位，表情包库未做 |
| v1.2 | 群日报、记忆卡美化、语音收（转文字） | 2.1d | 完成 |
| v1.3 | 火山引擎 TTS 发语音 | 1.5d | 未做（依赖未定） |

## 地基（v0.1 必须先证实）

| # | 待验证 | 验证方式 | 结论 |
|---|---|---|---|
| 1 | Host 插件能否直调 `sessionController` 的 `list/inspect/resolveAgent/follow/prompt` | `dev/session-probe` 注册一个诊断工具，逐项返回结果 | **通过**：6/6（list、modelCatalog、inspect、resolveAgent、projections、follow）。`prompt` 未跑（会往当前会话插消息），但走同一套 Remote 包装，风险已很低 |
| 2 | WS 事件路径是 `/` 还是 `/event`、token 带法 | 连接后看首帧 | **通过**：路径 `/`；**HTTP 与 WS 各有一个独立 token**（`networks.httpServers[].accessToken` 与 `wsServers[].accessToken` 不同），token 放查询参数 `?access_token=` |
| 3 | 已登录的 QQ 被注入后是否需要重新扫码 | 装好 SnowLuma 后看 WebUI 状态 | **通过**：注入即用，无需扫码。启动 1 秒内 `login detected: UIN=10002`，好友 34、群 12 |
| 4 | 审批回答通道如何注册 | 读 `approval` 服务的运行时行为 | **通过**：`ctx.tools.guard` 拦截 + QQ 里 `/yes` 放行 |
| 5 | `node:sqlite` 在 Electron 宿主是否可用 | 宿主里 `require('node:sqlite')` | **通过**：档案库已运行（`archive ready`） |
| 6 | FTS5（trigram）是否编入 | `PRAGMA compile_options` | **未用**：检索走 `LIKE`，够用 |
| 7 | GDI+ 中文渲染与 GIF 抽帧 | 跑一次渲染脚本 | **通过**：记忆卡出图、GIF 取 9 帧 |

> 探针一次安装即通过，说明 Remote 方法在进程内调用不会因缺少网关上下文而被拒。
> 注意：替换已安装包需要重启 DSH 才能加载新代码，所以后续开发先把功能攒齐再打包安装。

## 里程碑依赖

- v0.5 依赖 #1 通过；不通过则改为"客户端插件 + Host 代理"方案
- v0.9 依赖 #5、#7
- v1.2 依赖 #6


