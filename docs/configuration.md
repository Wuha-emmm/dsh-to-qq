# 配置参考

> 由 `npm run docs` 从 `src/config/defaults.js` 生成，改代码后重新生成即可；不要手改本文件。

配置文件位置：`~/.dsh/dsh-to-qq/config.json`（Windows：`C:\Users\<你>\.dsh\dsh-to-qq\config.json`）。
设置页修改的是同一份文件；`token` / `httpToken` 不会回显。

未知键会被丢弃，越界的数字会被夹到范围内。

## connection

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 总开关；关闭后桥不连接 OneBot、不处理任何消息 |
| `httpUrl` | `http://127.0.0.1:3000` | — | OneBot HTTP 地址，用于发消息、查状态、取语音 |
| `wsUrl` | `ws://127.0.0.1:3001` | — | OneBot 事件推送地址 |
| `eventPath` | `/` | — | 事件路径，SnowLuma 为 `/` |
| `botUin` | `0` | `0 ~ 99999999999` |  |
| `token` | `""`（空） | — | OneBot HTTP access token（设置页不显示） |
| `httpToken` | `""`（空） | — | 桥面板的额外口令（可留空，面板已限本机同源） |
| `tokenEnv` | `""`（空） | — |  |
| `httpTokenEnv` | `""`（空） | — |  |
| `autoStart` | `true` | — | DSH 启动时顺带拉起 SnowLuma |
| `snowlumaDir` | `""`（空） | — | SnowLuma 安装目录；填了才能自动启动 |
| `snowlumaWebui` | `http://127.0.0.1:5099` | — | SnowLuma 控制台地址，设置页的「打开控制台」用它 |
| `reconnect.enabled` | `true` | — | 断线后自动重连 |
| `reconnect.baseMs` | `1000` | — | 首轮重连等待 |
| `reconnect.maxMs` | `30000` | — | 重连等待上限（指数退避） |

## access

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `admins` | `[]` | — | 管理员 QQ 列表，私聊拥有全权 |
| `strangerPolicy` | `ignore` | — | 陌生人私聊：ignore / notice / block |
| `friendsAsMember` | `true` | — |  |
| `forwardRequests` | `true` | — |  |
| `requestTtlMin` | `30` | `1 ~ 1440` |  |
| `groupMode` | `whitelist` | — | 群策略：whitelist / blacklist / all |
| `groups` | `[]` | — | 参与策略的群号列表 |
| `mentionOnly` | `true` | — | 群里必须 @ 机器人才回应 |
| `blockedWords` | `[]` | — | 命中这些词的群消息直接丢弃 |

## models

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `searchPrice` | `0.005` | `0 ~ 100` |  |
| `fetchPrice` | `0.005` | `0 ~ 100` |  |
| `offPeakDiscount` | `0.5` | `0 ~ 1` |  |
| `peakWindows` | `09:00-12:00,14:00-18:00` | — |  |
| `peakHolidays` | `""`（空） | — |  |
| `inputPrice` | `2` | `0 ~ 1000` |  |
| `outputPrice` | `8` | `0 ~ 1000` |  |
| `cachePrice` | `0.04` | `0 ~ 1000` |  |
| `permissionPreset` | `danger-full-access` | — |  |
| `owner.provider` | `""`（空） | — | 管理员私聊使用的服务商；空 = DSH 默认 |
| `owner.model` | `""`（空） | — | 管理员私聊模型；空 = 该服务商首个模型 |
| `owner.effort` | `high` | — | 管理员私聊的推理级别；空 = 默认 |
| `member.provider` | `""`（空） | — | 访客与群成员使用的服务商；空 = DSH 默认 |
| `member.model` | `""`（空） | — | 访客与群成员模型 |
| `member.effort` | `""`（空） | — | 访客与群成员的推理级别 |
| `summarizer.provider` | `""`（空） | — | 翻译与印象整理使用的服务商；空 = 自动挑可用项 |
| `summarizer.model` | `""`（空） | — | 翻译与印象整理的模型 |
| `summarizer.effort` | `""`（空） | — | 翻译与印象整理的推理级别 |

## image

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `provider` | `ark` | — |  |
| `apiKey` | `""`（空） | — |  |
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | — |  |
| `model` | `doubao-seedream-5-0-flash-260915` | — |  |
| `size` | `1024x1024` | — |  |
| `watermark` | `false` | — |  |

## speech

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `provider` | `deepseek` | — | 语音合成服务商；目前只接了 deepseek |
| `apiKey` | `""`（空） | — | DeepSeek API Key（sk- 开头），用于原声 TTS |
| `baseUrl` | `https://api.deepseek.com` | — | DeepSeek 接口根地址 |
| `voiceId` | `stella` | — | 原声音色：stella（女）/ tide（男） |
| `format` | `wav` | — | 音频格式：wav（QQ 转 silk 最稳） |
| `local.enabled` | `false` | — | 本地肥鱼声音总开关；关 = 不启动任何进程、不占显存，全部回落原声 |
| `local.warm` | `true` | — | 常驻预热：模型留在显存里，每句约 0.2 秒（约 1.5–2 GB 显存）；关掉改成每句起进程（约 10 秒） |
| `local.root` | `""`（空） | — | 本地声音安装目录（含 server/、envs/、models/），例如 E:\feiyu |
| `local.serverRoot` | `""`（空） | — | 服务代码目录；留空 = <root>/server |
| `local.pythonPath` | `""`（空） | — | 跑队列的 Python；留空 = <root>/envs/service/Scripts/python.exe |
| `local.warmPython` | `""`（空） | — | 常驻进程用的 Python（要装 torch）；留空 = <root>/envs/rvc/Scripts/python.exe |
| `local.warmPackage` | `""`（空） | — | RVC 权重包目录；留空 = <root>/models/FeiyuVoice-RVC |
| `local.ttsWarm` | `true` | — | 用肥鱼自己的 CosyVoice3 声音说话：每句 1–3 秒，另占约 3.5 GB 显存；关掉 = 回落 DeepSeek 原声 |
| `local.ttsPython` | `""`（空） | — | TTS 常驻进程用的 Python；留空 = <root>/envs/tts/Scripts/python.exe |
| `local.ttsModel` | `""`（空） | — | CosyVoice3 权重包；留空 = <root>/models/FeiyuVoice-CosyVoice3 |
| `local.ttsProfile` | `""`（空） | — | CosyVoice 运行档案；留空 = <root>/server/configs/runtime.tts.cuda.local.json |
| `local.ttsServer` | `""`（空） | — | TTS 常驻进程要用的服务代码；留空 = <root>/server |
| `local.baseUrl` | `http://127.0.0.1:9880` | — | 本地服务地址（只绑 127.0.0.1） |
| `local.apiKey` | `""`（空） | — | 本地服务 Bearer；留空 = 读 <server>/.runtime/voice-service/api_key.txt |
| `local.style` | `cute` | — | 肥鱼参考音色：cute（可爱）/ gentle（温柔） |
| `local.autoStart` | `true` | — | 第一次发语音时自动拉起服务 |
| `local.idleStopMinutes` | `15` | — | 多少分钟没有语音就退出服务（0 = 常驻） |
| `local.jobTimeoutMs` | `180000` | — | 单条推理超时；冷启动要重新加载 6 GB 权重 |
| `local.coverTimeoutMs` | `1800000` | — | 整首翻唱的超时（分离 + 换声 + 混音，一首歌要几分钟） |
| `local.startTimeoutMs` | `60000` | — | 拉起服务后等 /health 的时间 |
| `local.pathPrefix` | `""`（空） | — | 给子进程补的 PATH（验证运行时需要 git） |

## conversation

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `cwd` | `""`（空） | — | 为 QQ 会话指定工作目录；空 = DSH 默认 |
| `groupHistory` | `99` | `0 ~ 200` | 群聊每次注入的历史消息条数 |
| `groupCharCap` | `6000` | `500 ~ 40000` | 注入群上下文的字数上限 |
| `cleanupKeepHours` | `24` | — |  |
| `archiveOldSessions` | `true` | — |  |
| `autoRebuildKb` | `0` | — |  |
| `groupPrivacy` | `true` | — |  |

## memory

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `redactSensitive` | `true` | — |  |
| `sensitiveWords` | `[]` | — |  |
| `summaryLimit` | `1000` | `200 ~ 4000` | 单张记忆卡保留的字数上限 |
| `personaLimit` | `1000` | `100 ~ 4000` | 人设文本长度上限 |
| `autoNoteEvery` | `8` | `0 ~ 100` | 每 N 轮提醒模型记一条；0 = 关闭 |
| `impressionsEnabled` | `true` | — | 后台自动整理印象（不发消息） |
| `impressionEvery` | `100` | `20 ~ 1000` | 攒够多少条发言整理一次印象 |
| `impressionMinChars` | `800` | `100 ~ 5000` | 触发整理前至少需要的有效字数 |
| `impressionBudget` | `600` | `200 ~ 2000` | 印象列表总字数上限 |

## accounts

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `browserPath` | `""`（空） | — |  |
| `debugPort` | `9333` | `1024 ~ 65535` |  |

## limits

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `memberDaily` | `100` | `0 ~ 10000` | 每人每天可提问次数（0 = 不限） |
| `groupDaily` | `400` | `0 ~ 100000` | 每群每天可回答次数（0 = 不限） |
| `userPerMinute` | `8` | `1 ~ 30` | 每人每分钟最多提问次数 |
| `maxInputChars` | `2000` | `200 ~ 20000` | 单条消息超过此长度会被截断 |
| `concurrency` | `4` | `1 ~ 5` | 同时进行的回答数 |
| `queueMax` | `10` | `1 ~ 50` | 排队上限，超过直接拒绝 |
| `turnTimeoutMs` | `180000` | `60000 ~ 3600000` | 单轮回答超时，超时后释放并发槽 |
| `turnIdleMs` | `300000` | `30000 ~ 3600000` |  |
| `replyDelayMs` | `2000` | `0 ~ 30000` | 回答前的基础延迟 |
| `jitterMs` | `1500` | `0 ~ 10000` | 在基础延迟上叠加的随机抖动 |
| `maxDelayMs` | `15000` | `0 ~ 120000` | 延迟上限 |
| `batchMaxWaitMs` | `7000` | `0 ~ 120000` |  |
| `overLimit` | `refuse` | — | 超限行为：refuse / silent / queue |

## output

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `imageThreshold` | `500` | `100 ~ 5000` | 回答超过该字数就转成图片 |
| `maxReplyChars` | `250` | `0 ~ 4000` |  |
| `replyCharsOwner` | `400` | `0 ~ 4000` |  |
| `replyCharsGroup` | `300` | `0 ~ 4000` |  |
| `style` | `light` | — | 图片风格：light / dark / bubble |
| `fontSize` | `22` | `14 ~ 48` | 转图字号 |
| `width` | `1080` | `600 ~ 2000` | 转图宽度（像素） |
| `sendProcessingHint` | `false` | — | 回答前先发一句「收到，正在处理」 |
| `sendTypingStatus` | `true` | — | 显示 QQ「正在输入」状态 |
| `groupAtReply` | `true` | — | 群聊回复开头 @ 提问的人，避免多人同时问时分不清对象 |

## archive

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 是否记录聊天档案 |
| `media` | `true` | — | 把收到的图片存到本地 media/ |
| `retentionDays` | `30` | `0 ~ 3650` | 档案与媒体的保留天数（0 = 永久） |
| `mediaRetentionDays` | `7` | `0 ~ 3650` |  |

## backup

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `auto` | `true` | — |  |
| `keep` | `7` | `1 ~ 365` |  |
| `includeMedia` | `false` | — |  |
| `includeCookies` | `true` | — |  |

## stickers

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 向模型提供表情包库并允许发送 |
| `inPrompt` | `24` | `0 ~ 60` | 每次提示里列出多少张表情 |
| `perHourPerScene` | `3` | `0 ~ 20` | 同一个会话每小时最多发几张 |
| `describeBatch` | `20` | `0 ~ 100` | 每次同步最多识别多少张新表情 |

## voice

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 收到语音时是否转文字 |
| `language` | `zh` | — | 识别语言，如 zh / en |
| `command` | `""`（空） | — | 本地识别命令模板（{input} {language}）；留空不用 |
| `qqAsr` | `true` | — | 是否使用 QQ 原生语音转文字（默认开） |

## digest

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `false` | — | 每天定时把群日报图发到群 |
| `hour` | `22` | — | 日报时间（北京时间，0-23） |
| `minute` | `0` | — | 日报时间（分，0-59） |
| `groups` | `[]` | — | 要发日报的群；空 = 跟随 access.groups |

## safety

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `confirmWrite` | `true` | — | 危险工具需要 QQ 里 `/yes` 确认 |
| `confirmTtlMs` | `180000` | `10000 ~ 600000` | 确认的有效期 |
| `toolGrantMinutes` | `15` | `1 ~ 120` |  |
| `audit` | `true` | — | 记录审计事件 |

## appearance

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `background` | `""`（空） | — |  |
| `backgroundDim` | `55` | `0 ~ 95` |  |
| `backgroundBlur` | `0` | `0 ~ 24` |  |
