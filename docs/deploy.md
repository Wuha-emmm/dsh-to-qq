# 部署指南

从零到"在 QQ 里指挥本机的 DSH"。全流程约 15 分钟，只需要一台常开的 Windows 电脑。

> 本文以 Windows 10/11 + DSH 桌面版为准。Linux 也能跑核心逻辑，但卡片渲染依赖 Windows 的 GDI+（PowerShell），需要另行替换渲染器。

## 0. 你将得到什么

- 一个 QQ 小号变成机器人，大号私聊它就是和本机 DSH 对话（可读写文件、跑命令）
- 群成员 @ 机器人即可问答（只读，不能写盘/执行）
- 图片、语音、文件、合并转发、引用都能进对话
- `/记忆卡`、`/日报` 出图；印象自动整理

## 1. 前置条件

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 x64 | 渲染卡片用 PowerShell + GDI+ |
| Node.js | ≥ 22 | 需要内置 `node:sqlite` 与 `fetch` |
| DeepSeek Harness | 桌面版 0.2.x | 插件按 Host 插件加载 |
| SnowLuma | 2.2.x | QQ 协议端，提供 OneBot v11 |
| QQ 账号 | 一个小号 + 你常用的号 | 小号登录 SnowLuma，大号用来指挥 |
| DSH 模型 | 至少一条可用路由 | 设置 → 模型 里确认能对话 |

**运行时零 npm 依赖**：插件只用 Node 内置能力（`fetch`、`WebSocket`、`node:sqlite`、`child_process`）和 DSH 注入的服务（`sessionController`、`tools`、`webServer`、`llm`、`userQuestions`、`attachments`）。不需要 `pnpm install` 装任何第三方库。

## 2. 部署 SnowLuma

1. 从 [SnowLuma 官网](https://snowluma.github.io/) 下载 Windows 压缩包，解压到固定目录，例如 `D:\SnowLuma`。
2. 双击 `start.cmd`（或 `start.vbs` 静默启动），等待控制台/托盘出现。
3. 打开 WebUI（默认 `http://127.0.0.1:5099`），扫码登录**小号**。
4. 加载 hook：WebUI 里点一次"注入 / 加载"，确认状态为已连接。
5. 确认 OneBot 端口：
   - HTTP：`http://127.0.0.1:3000`
   - WebSocket：`ws://127.0.0.1:3001`
   - 形如 `config/onebot_<QQ>.json` 的文件里有 `networks.httpServers[0].accessToken`（HTTP token）和 `wsServers[0].accessToken`（WS token）。**两者不同**，桥只用 HTTP token。

验证：浏览器打开 `http://127.0.0.1:3000/get_login_info`（带 `Authorization: Bearer <HTTP token>`），返回 `status: ok` 即通。

## 3. 安装插件

### 方式 A：给已有 DSH 装（推荐）

```powershell
# 在仓库目录打包
pnpm pack --pack-destination dist
# 得到 dist\dsh-to-qq-<version>.tgz
```

然后让 DSH 安装：

- 图形界面：设置 → 插件 → 从文件安装，选那个 `.tgz`
- 或在有 `dsh` 命令的终端里：

```powershell
dsh plugin install "file:///E:/你的路径/dist/dsh-to-qq-0.41.0.tgz" --profile desktop
```

也可以直接指向**解压后的目录**（开发时更省事）：

```powershell
dsh plugin install "E:\DSH-to-QQ" --profile desktop
```

安装完成后**重启 DSH**（Host 半边的代码只在启动时加载）。

### 方式 B：本仓库自己就是源码

如果你把这套文件放进 `%USERPROFILE%\.dsh\` 之外任意目录，方式 A 的"指向目录"即可。

## 4. 首次配置

重启后打开 **设置 → QQ 桥接**。至少填这五项：

| 字段 | 填什么 |
|---|---|
| OneBot HTTP | `http://127.0.0.1:3000` |
| OneBot WS | `ws://127.0.0.1:3001` |
| SnowLuma 目录 | `D:\SnowLuma`（填了才能自动拉起） |
| 管理员 QQ | 你的大号 |
| 群号 | 允许进出的群，逗号分隔 |

`token` 不在界面显示，需要直接编辑配置文件：

```json
// %USERPROFILE%\.dsh\dsh-to-qq\config.json
{ "connection": { "token": "<HTTP accessToken>" } }
```

改完重启 DSH，设置页顶部的状态点应变绿。

## 5. 验证清单

按顺序做，任何一步失败先看 [troubleshooting.md](troubleshooting.md)：

1. `qq_status`（在 DSH 里让模型调用）应返回 `transport online`、`images ok`、`speech:` 与 `impressions:` 行
2. 大号私聊机器人发「在吗」→ 应在几秒内回复
3. 群里 @ 机器人问一句 → 应回复；不 @ 时不应答
4. 让私聊发 `/记忆卡` → 应收到一张 PNG
5. 发一条 3 秒语音 → 回复里带「语音转写（QQ 识别）：…」
6. 设置 → 对话 → 表情包库 → 立即同步；同步完成后闲聊几句，看模型会不会在合适的时机发表情
7. 引用一条消息再问 → 应能复述被引用的内容
8. 打开设置页 → 连接页签显示绿色「已连接」

## 6. 数据与备份

| 路径 | 内容 |
|---|---|
| `%USERPROFILE%\.dsh\dsh-to-qq\config.json` | 全部配置（含 token） |
| `…\sessions.json` / `guests.json` | 场景 ↔ DSH 会话绑定 |
| `…\memory.json` | 记忆卡（人设、印象、游标）与运行统计 |
| `…\archive.db` | 消息档案（SQLite，WAL） |
| `…\media\` | 可选保存的图片、卡片底图 |

备份直接复制整个 `dsh-to-qq` 目录即可。**`config.json` 含 token，分享前删掉。**

档案默认保留 30 天（`archive.retentionDays`），插件每 6 小时自动清理一次数据库行与媒体文件；也可在设置 → 档案 里手动点「立即清理」。

## 7. 升级与卸载

```powershell
# 升级：装新包后重启 DSH
dsh plugin install "file:///.../dsh-to-qq-0.42.0.tgz" --profile desktop

# 卸载
dsh plugin remove dsh-to-qq --profile desktop
```

升级不会动 `~/.dsh/dsh-to-qq/` 下的数据。卸载后要彻底清干净，再手删该目录。

## 8. 安全须知

1. 插件会读取这个 QQ 号收到的**全部消息**，并能以你的名义操作本机（管理员私聊）。
2. **管理员名单就是唯一口令**：QQ 号被盗 = 本机沦陷。建议专门开一个小号做机器人。
3. 群聊一律禁写禁执行；群里的文字按不可信输入对待。
4. 设置面板只接受**本机回环 + 同源**请求，跨域会被 403。
5. `config.json` 里的 token 是明文，注意不要把整个目录传到公开仓库。

## 9. 目录结构

```
dsh-to-qq/
├─ src/            Host 半边：接入、判权、上下文、记忆、档案、渲染、工具
├─ client/         Web UI 半边：悬浮宠物、面板、设置页
├─ docs/           设计、部署、配置、排障、路线
├─ scripts/        smoke / inventory / rehearse / docs 生成
├─ test/           node:test，零依赖
└─ cordis.patch.yml  DSH 插件声明
```

