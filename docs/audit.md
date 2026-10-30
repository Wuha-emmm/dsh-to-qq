# 体检报告（0.42.0）

覆盖 0.42.0：印象系统、合并转发展开（含嵌套与图片）、引用解析取图、设置页补印象面板、P0/P1/P2 清债。

## 验证手段（可重复执行）

| 命令 | 作用 | 当前结果 |
|---|---|---|
| `npm test` | 153 条单测 | 全过 |
| `npm run smoke` | 真调 `apply()`，抓 TDZ / 缺服务 | activation ok，9 工具 / 12 路由 |
| `npm run inventory` | 静态盘点：文件、工具、命令、路由、配置键 | 41 文件 / 8114 行，**死键 0** |

`smoke` 是 0.33 之后补的：`node --check` 只验语法，验不出前置引用——0.32.x 那个 TDZ 让插件整体不加载，就是缺这道检查。

## 规模

| 文件 | 行数 | 评价 |
|---|---|---|
| `src/bridge/runtime.js` | 1124 | 仍偏大，但印象运行器已外移 |
| `client/client.js` | 1006 | 单文件受加载器限制，暂不拆 |
| `src/index.js` | 838 | 工具 + 路由 + 面板 API |
| `src/archive/db.js` | 370 | 合理 |
| `src/render/memory-card.ps1` | 360 | 合理 |
| `src/bridge/sessions.js` | 354 | 合理 |
| `src/bridge/impression-run.js` | 233 | 新增，印象运行器 |
| `src/media/forward.js` | 241 | 新增，转发展开 |

## 已解决的问题（本轮）

1. **21 个死配置键** → 全部删除，`inventory` 死键清单清零；`normalize` 里会把 `autoCleanAt` 写回的残留逻辑一并移除。
2. **`#probeQuestions()` 死方法** → 删除，`lastQuestionProbe` 字段一并移除；换成真实待答问题列表。
3. **面板 API 无鉴权** → 新增 `src/web/guard.js`：非回环地址 403，跨域 Origin 403，5 条测试覆盖。
4. **转发/引用图片不入档** → 存档循环移到图片合并之后，转发里的图片也会写进 `media/`。
5. **`qq_status` 信息不足** → 印象行补 `retried` / `last`，并加入 `owner-group` 白名单。
6. **印象统计不持久化** → 写进 `memory.json` 的 `meta.impressions`，重启仍在。
7. **印象重复跑** → 同一人 30 分钟冷却（`impressionRanAt`）。
8. **提问回填只有观测** → 已接线：`tool/call` 捕获 `ask_user_question` 的 questions，QQ 回复经 `parseReply` 转成 `{ answers }` 后调 `userQuestions.answer`。
9. **计时器各自为政** → 统一 `schedule()`，dispose 一次清空。

## 仍存在的问题

1. **`media/` 没有清理**：配额键已删，`prune()` 只删数据库行，图片文件会无限增长。需要"按 `archive.retentionDays` 一并删文件"。
2. **入站文件只有 `[文件]` 占位**：README 承诺"收发文件图片"，出站能发、入站读不到。需要 `get_file` 拉取。
3. **客户端无法拆分**：`client/client.js` 由 `__ModuleLoader__` 单文件加载，拆文件需要打包器支持。
4. **测试偶发失败**：临时文件 `rename` 竞态，连跑 3 轮均 153/0，尚未定位具体用例。
5. **印象冷却不持久**：重启后 30 分钟冷却清零。

## 功能完整度

| 功能 | 状态 |
|---|---|
| 私聊 / 群聊问答、@ 触发、上下文缓冲 | ✅ |
| 图片入 prompt（含 GIF 帧图）、语音转写 | ✅ |
| 记忆卡 / 群日报出图，出图后静默 | ✅ |
| 人设 / 印象、`/人设` 命令 | ✅ |
| 印象批量整理（100 条触发、跨场景、游标、冷却、持久化） | ✅ |
| 设置页补印象按钮 + 进度 + 上次时间 | ✅ |
| 合并转发展开（两层）＋ 转发内图片 ＋ 引用取图 | ✅ |
| 引用解析（缓冲区 → `get_msg` → 展开转发） | ✅ |
| 归档检索、按天清理 | ✅ |
| 提问回填（`ask_user_question` 从 QQ 回答） | ✅ 已接线，待实测 |
| 入站文件读取 | ❌ |
| 媒体文件清理 | ❌ |
| 主动提醒 / 表情包库 / TTS | ❌ 未做（roadmap v1.0–v1.3） |

## 结论

README 的五条承诺（私聊全权、群聊只读、陌生人仅聊天、记忆卡、档案）全部落地；剩余缺口集中在"媒体生命周期、入站文件、三个 v1.x 功能"。核心链路有 153 条测试与 `smoke` 兜底，可以先稳定使用再补功能。

