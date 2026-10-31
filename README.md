# DSH-to-QQ

用 QQ 遥控你电脑里的 **DeepSeek Harness**：管理员私聊等同在本机打字，群里 @ 一下就能问答，语音/图片/文件/合并转发都能进对话。

> Bridge between QQ and DeepSeek Harness. Owner DMs get full local access; group mentions stay read-only.

`Node ≥ 22` · `MIT` · 零 npm 运行时依赖 · 单测 213 条

---

## 快速开始

**第一步**：双击仓库根目录的 `setup.cmd`。它会自动找到 DSH 自带的 Node、打包插件、检查 SnowLuma，并把安装指令复制到剪贴板。

**第二步**：把复制到的这句话粘给 DSH：

```
请帮我安装本地插件包，装完提醒我重启 DSH：
file:///<你的路径>/dsh-to-qq/dist/dsh-to-qq-<版本>.tgz
```

装完重启 DSH → 打开「设置 → QQ 桥接」→ 填 OneBot token。

> 最后一步（写 profile 与 Cordis 补丁）交给 DSH 的插件管理器做。外部脚本硬改 profile 容易把它弄坏，所以脚本只准备、不越权。

完整步骤见 **[安装说明](docs/install.md)** 与 **[部署指南](docs/deploy.md)**。

## 能做什么

| 场景 | 行为 |
|---|---|
| **私聊（管理员）** | 全权：读写文件、跑命令、收发图片文件 |
| **群聊** | 只读问答：仅被 @ 时回应，能联网、能读上下文，不能写盘/执行 |
| **好友** | 机器人好友私聊按成员档：聊天、联网、记忆、表情，无本机读写 |
| **陌生人** | 没加好友的私聊按 `strangerPolicy` 忽略（默认） |
| **申请** | 加好友/入群/邀请进群转给管理员，`/同意 N` `/拒绝 N` 处理 |
| **卡片** | 分享卡片读出标题、正文、来源、链接（邀请进群还带群名群号） |
| **网页** | `fetch_page`：带浏览器头抓取、解析短链、B站走公开 API（`web_fetch` 被挡时用它） |
| **站点登录** | 设置 →「登录」：B站扫码 / 粘贴 cookie，小红书粘贴 cookie；登录后抓取会带上那份 cookie |
| **@** | 群回复里的 `@名字` 转成真正的 at，被 @ 的人会收到提醒 |
| **语音** | QQ 原生转写优先，失败再走本地/命令 |
| **图片** | 含 GIF，作为附件进对话；转发与引用里的图也会取出 |
| **合并转发** | 两层展开，40 条 / 4000 字预算 |
| **记忆** | 按 QQ 号积累人设与印象，跨群跨私聊共用，可出图 |
| **表情包** | 同步收藏表情、视觉模型结构化识图、可手改，模型自行决定何时发 |
| **档案** | SQLite 记录谁在何时说了什么，可检索、按天清理 |
| **日报** | 群日报出图，出图后不再补话 |
| **会话** | 自动命名 `【私】名字` / `【群】群名`，统一归到项目文件夹 |
| **上下文** | 记忆卡 / 表情清单 / 群规每会话只发一次，群窗口只补新消息；需要瘦身时用 `/重建`（带走最近 14 条，旧会话归档） |
| **会话清理** | `/清理会话` 或设置页「档案 → QQ 会话清理」，先预览再归档未绑定的旧会话 |
| **用量** | 设置页「用量」：每轮 token、缓存命中率、按峰谷价估算的费用 |
| **回复长度** | 可设上限（默认 250 字），超长回复自动转成图片 |

设置页 7 个页签：连接 / 权限 / 对话 / 记忆 / 表情 / 模型 / 档案。

## 权限模型

| 能力 | 私聊管理员 | 群成员 | 陌生人 |
|---|---|---|---|
| 会话驱动（回复） | ✅ | ✅ | ✅ |
| 联网工具 | ✅ | ✅ | ✅ |
| 读写本机文件 / 执行命令 | ✅ | ❌（群内管理员也没有） | ❌ |
| 记忆卡 / 表情 / 日报 | ✅ | ✅ | 部分 |
| 改权限 | 仅本机面板 | ❌ | ❌ |

三条硬规则：管理员名单是唯一口令；群聊文本一律视为不可信输入；面板只接受本机回环 + 同源请求。详见 **[权限模型](docs/permission-model.md)**。

## 工作原理

```
QQ 手机 ──▶ SnowLuma（OneBot 11）──▶ dsh-to-qq Host 插件 ──▶ DSH 会话
                    ▲                        │
                    └──── 回复/图片/卡片 ◀────┘
```

Host 半边负责接入、判权、上下文、记忆、档案与工具；Client 半边在 DSH 的 Web UI 里提供悬浮宠物与会话面板。除了 SnowLuma（QQ 协议端）不引入任何外部服务，也不依赖 `node_modules` 里的运行时包。

## 文档

| 文档 | 内容 |
|---|---|
| [安装](docs/install.md) | 一键 / 手动 / 卸载 |
| [部署](docs/deploy.md) | SnowLuma、QQ 小号、token、验收清单 |
| [配置参考](docs/configuration.md) | 全部配置项（自动生成） |
| [表情包库](docs/stickers.md) | 同步、识图、手改、免打扰 |
| [权限模型](docs/permission-model.md) | 三档权限与工具矩阵 |
| [架构](docs/architecture.md) | 模块划分与数据流 |
| [排障](docs/troubleshooting.md) | 常见故障与日志位置 |
| [SnowLuma 备忘](docs/snowluma.md) | 端口、双 token、状态码 |
| [SnowLuma API](docs/snowluma-api.md) | 离线 API 参考：调用约定 + 219 个 OneBot 动作索引 |
| [路线](docs/roadmap.md) | 已完成与下一步 |
| [更新记录](CHANGELOG.md) | 每个版本改了什么（一句话一条） |

## 开发

```powershell
npm test           # 213 条单测
npm run smoke      # 真调 apply()，抓前置引用/缺服务
npm run rehearse   # 端到端：解码→判权→上下文→卡片渲染→鉴权
npm run inventory  # 文件、工具、命令、路由、配置键盘点
npm run docs:check # 配置参考是否与默认值一致
```

```
src/       Host 插件（接入、判权、上下文、记忆、档案、渲染、工具）
client/    Web UI 半边（悬浮宠物、会话面板、设置页）
docs/      文档
scripts/   自检与辅助脚本
test/      node:test，零依赖
dev/       开发期辅助 bundle（不随插件发布）
```

依赖都在机器上，不在 `node_modules` 里：Node ≥ 22、DSH 桌面版 0.2.x、SnowLuma 2.2.x、系统 PowerShell（GDI+ 渲染）。

## 安全

1. 它会读取你 QQ 收到的**全部消息**，并以你的名义操作本机。
2. 管理员 QQ 号被盗 = 本机沦陷；建议机器人用小号。
3. `config.json` 含**明文 OneBot token**，分享前删掉——见 [SECURITY.md](SECURITY.md)。

## 许可

代码 MIT，见 [LICENSE](LICENSE)。宠物动画等第三方素材的授权单独说明，见 [NOTICE.md](NOTICE.md)。

