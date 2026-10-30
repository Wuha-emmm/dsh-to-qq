# SnowLuma 部署备忘

SnowLuma 是桥接的 QQ 侧实现（OneBot 11 兼容）。这里记的是部署时会踩到的点，不是本机环境记录。

## 安装与启动

- 从 [官网](https://snowluma.github.io/) 下载 Windows 解压版，放到固定目录（例如 `D:\SnowLuma`）
- 启动：双击 `launcher.bat`，或在该目录里执行 `node.exe .\index.mjs`（工作目录必须是该目录）
- 后台运行请用计划任务或开机脚本；**重启电脑后不会自动拉起**
- 日志：`run.out.log` / `run.err.log`

插件设置里的「SnowLuma 目录」填这个路径后，可以在 DSH 启动时自动拉起。

## 端口

| 端口 | 用途 | 绑定 |
|---|---|---|
| 3000 | OneBot HTTP（调用动作） | 127.0.0.1 |
| 3001 | OneBot WebSocket（接收事件） | 127.0.0.1 |
| 5099 | WebUI | 127.0.0.1 |

非 Docker 安装默认就是回环，不需要改绑定。

## 两个 token（最容易踩）

`config/onebot_<uin>.json` 里 **HTTP 与 WS 各有一个独立 token**：

```
networks.httpServers[0].accessToken   → 调用动作时用
networks.wsServers[0].accessToken     → 连接事件流时用
```

两个都要填进插件配置（`connection.httpToken` / `connection.wsToken`），填错一个的表现是：能发消息但收不到事件，或者反之。

## WebUI 与注入

1. 打开 `http://127.0.0.1:5099`，扫码登录**小号**
2. 在 WebUI 里点一次「注入 / 加载」，状态变成已连接
3. DSH 重启后 hook 会掉，需要重新注入（或用「自动启动」让插件来处理）

## 常见状态码

| 现象 | 含义 |
|---|---|
| `result=-13100` | 服务端拒绝该元素（常见于手工拼的 `mface`） |
| `retcode 100` | 调用失败，看 `wording` |
| `retcode 0` | 成功，`data.message_id` 是消息 id |
| `ptt translate failed: error=9` | 语音转写还没就绪，重试一次通常就好 |
