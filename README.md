# DSH-to-QQ

把 DeepSeek Harness 接到 QQ：你的 QQ 大号在手机上指挥电脑里的 DSH。管理员私聊拥有全权（读写文件、跑命令），群里 @ 机器人即可问答（只读），语音、图片、文件、合并转发都能进对话。

> 零 npm 运行时依赖，只用 Node 内置能力与 DSH 注入的服务。

## 它做什么

- **私聊 = 全权**：管理员发一句话，等于在 DSH 输入框里打字——读写文件、跑命令、收发文件图片。
- **群聊 = 只读问答**：只有被 @ 才回应，能联网查资料、能读上下文，但不能写盘、不能执行。
- **陌生人 = 仅聊天**：没有任何本机权限，只能联网问答。
- **记忆卡**：按 QQ 号积累"这个人"的人设与印象，跨群跨私聊共用，可出图。
- **档案**：谁在什么时间说了什么，可检索、按天清理。

## 功能状态

**已实现**

- 私聊全权、群聊只读、陌生人仅聊天；`/列表 /切换 /新建 /暂停 /恢复` 遥控会话
- 会话命名：私聊 `【私】名字`、群聊 `【群】群名`，统一归到「会话项目文件夹」
- 图片（含 GIF 帧图）、语音转文字（QQ 原生优先）、收到文件落盘
- 表情包库：独立「表情」页签，自动同步收藏表情、按「画面/情绪/用途」结构化识图（可重识别）、可手改编号/分类/备注；QQ 自带小黄脸（`emoji_send`）零准备可用；模型自行决定何时发，对方说过不收就不再发
- 合并转发展开（两层）与引用解析，转发/引用里的图片同样作为附件送入
- 记忆卡（人设 + 印象）、印象批量整理（100 条触发、跨场景、游标、冷却、持久化）
- 群日报与记忆卡出图；出图后不再补一句话
- 档案：SQLite 检索、按天清理（数据库行与媒体文件一起删）
- 设置页：连接 / 权限 / 对话 / 记忆 / 表情 / 模型 / 档案

**未实现**

- 主动提醒、TTS 发语音
- 向量检索（当前是关键词 `LIKE`）

## 快速开始

```powershell
pnpm pack --pack-destination dist
# 在 DSH 里：plugin_manager install_bundle → file:///<绝对路径>/dist/dsh-to-qq-<版本>.tgz
# 重启 DSH，打开 设置 → QQ 桥接
```

完整步骤（包含 SnowLuma 安装、QQ 小号、token 填写）见 **[部署指南](docs/deploy.md)**。

## 依赖

**运行时零依赖**。需要的东西都在机器上，而不是 `node_modules` 里：

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 22 | `fetch`、`WebSocket`、`node:sqlite` |
| DeepSeek Harness | 桌面版 0.2.x | 插件宿主与会话驱动 |
| SnowLuma | 2.2.x | QQ 协议端，提供 OneBot v11 |
| PowerShell | 系统自带 | 卡片与缩略图渲染（GDI+） |
| 一个已登录的 QQ 小号 | — | 机器人账号 |

不依赖任何 `@deepseek-ai/*` 包（profile 级插件解析不到它们），也不引入原生模块。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | Host 插件：接入、判权、上下文、记忆、档案、渲染、工具 |
| `client/` | Web UI 半边：悬浮宠物、会话面板、设置页 |
| `docs/` | [部署](docs/deploy.md)、[配置参考](docs/configuration.md)、[表情包库](docs/stickers.md)、[SnowLuma 备忘](docs/snowluma.md)、[架构](docs/architecture.md)、[权限模型](docs/permission-model.md)、[排障](docs/troubleshooting.md)、[路线](docs/roadmap.md) |
| `scripts/` | `smoke`（真跑 apply）、`inventory`（静态盘点）、`rehearse`（端到端预演）、`docs-config`（生成配置参考） |
| `test/` | `node:test`，零依赖 |
| `dev/` | 开发期辅助 bundle（不随插件发布） |

## 自检

```powershell
npm test           # 189 条单测
npm run smoke      # 真调 apply()，抓前置引用/缺服务
npm run rehearse   # 端到端：解码→判权→上下文→卡片渲染→鉴权
npm run inventory  # 文件、工具、命令、路由、配置键盘点
npm run docs:check # 配置参考是否过期
```

## 安全前提（务必先读）

1. 它会读取你 QQ 收到的**全部消息**，并以**你的名义**操作本机。
2. 管理员名单是唯一的口令。QQ 号被盗 = 本机沦陷。
3. 群聊一律禁写禁执行，群里任何人的文本都当作**不可信输入**。
4. 设置只能在本机改（面板只接受回环 + 同源请求），QQ 侧不能改权限。
5. `config.json` 含明文 OneBot token，分享前删掉——见 [SECURITY.md](SECURITY.md)。

## 许可

MIT。见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
