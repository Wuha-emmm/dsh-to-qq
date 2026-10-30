# SnowLuma HTTP API 参考（离线版）

> 来源：<https://snowluma.github.io/zh/docs/api>
> 导出时间：2026-10-30
> 覆盖：调用约定 + 全部 12 个分类、219 个 OneBot 动作索引
> 每个动作的参数 schema、返回 schema 和示例在各自动作页（下表已给出直达链接），此处不重复。

SnowLuma 的 HTTP API 与 **OneBot v11** 兼容。每个动作一页，由 OpenAPI 插件渲染：请求体、鉴权、应答信封、代码示例，以及对着你自己的实例试调。

---

## 1. 怎么调用

- 方法：`POST /{动作名}`
- 请求体：`Content-Type: application/json`
- 默认服务：`http://127.0.0.1:3000/`（同一 Docker 网络里用 `http://snowluma:3000/`）
- 鉴权（配置了 token 时）：`Authorization: Bearer <token>`，或查询参数 `?access_token=`
- WebSocket：`ws://127.0.0.1:3001/`，动作名与 HTTP 相同

## 2. 应答信封

HTTP 200 仍可能是业务失败。看信封里的 `retcode`：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {},
  "message": "",
  "wording": ""
}
```

`retcode` 为 `0` 才是成功。`data` 的形状见各动作页。

## 3. 在文档里试调

打开任意动作页，填服务地址和 token，用试调面板直接发请求。请求发自你的浏览器，目标是你填的服务器，不是文档站。

MCP 客户端不必手写 HTTP，见 <https://snowluma.github.io/docs/mcp>。

## 4. 通用约定

- **动作名**：即 URL 路径，大小写敏感；少数动作带别名（下表标出），也有以 `.` 开头的兼容名（如 `.get_word_slices`）。
- **`message_id`**：非零的有符号 32 位整数，负值合法。不要取绝对值，也不要改成字符串。
- **`group_id` / `user_id`**：正整数（`uint`），不传 0。
- **只读动作**：标记为「只读」的动作不修改任何状态，可用于健康检查或 MCP 只读模式。
- **流式动作**（`流式接口` 分类）：返回多帧，形状为 `file_info → file_chunk* → file_complete`，不是普通 `data`。
- 环境变量与端口见配置参考：<https://snowluma.github.io/zh/docs/guide/configuration>

### 调用示例

```bash
# 登录信息
curl -X POST http://127.0.0.1:3000/get_login_info \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'

# 发群消息
curl -X POST http://127.0.0.1:3000/send_group_msg \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"group_id":123456,"message":[{"type":"text","data":{"text":"hello"}}]}'

# 运行状态
curl -X POST http://127.0.0.1:3000/get_status \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
```

---

## 5. 全部动作（219）

计数：扩展 115 · 群管理 24 · 信息 5 · 群相册 9 · 流式接口 6 · 空间 26 · 群文件 12 · 好友 3 · 消息 6 · 系统表情 4 · 群信息 7 · 请求 2。

### 5.1 扩展（115）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [_del_group_notice](https://snowluma.github.io/zh/docs/api/extended/_del_group_notice) | 删除群公告（fid 或 notice_id 二选一） |  |
| [_get_friend_dress](https://snowluma.github.io/zh/docs/api/extended/_get_friend_dress) | 获取指定 QQ 号正在使用的个性装扮（挂件/名片/来电/输入状态等） | 只读 |
| [_get_group_notice](https://snowluma.github.io/zh/docs/api/extended/_get_group_notice) | 获取群公告（普通公告与新成员公告合并返回） | 只读 |
| [_get_model_show](https://snowluma.github.io/zh/docs/api/extended/_get_model_show) | 获取机型展示（兼容 mock） | 只读 |
| [_mark_all_as_read](https://snowluma.github.io/zh/docs/api/extended/_mark_all_as_read) | 标记全部已读 |  |
| [_send_group_notice](https://snowluma.github.io/zh/docs/api/extended/_send_group_notice) | 发送群公告（支持置顶、弹窗、新成员、群昵称引导与确认） |  |
| [_set_model_show](https://snowluma.github.io/zh/docs/api/extended/_set_model_show) | 设置机型展示（占位） |  |
| [.get_word_slices](https://snowluma.github.io/zh/docs/api/extended/.get_word_slices) | 分词（未实现） | 只读 |
| [add_custom_face](https://snowluma.github.io/zh/docs/api/extended/add_custom_face) | 添加收藏表情 |  |
| [bot_exit](https://snowluma.github.io/zh/docs/api/extended/bot_exit) | 退出机器人 |  |
| [cancel_group_todo](https://snowluma.github.io/zh/docs/api/extended/cancel_group_todo) | 取消群待办 |  |
| [check_url_safely](https://snowluma.github.io/zh/docs/api/extended/check_url_safely) | 检查链接安全性 | 只读 |
| [clean_cache](https://snowluma.github.io/zh/docs/api/extended/clean_cache) | 清理缓存 |  |
| [click_inline_keyboard_button](https://snowluma.github.io/zh/docs/api/extended/click_inline_keyboard_button) | 点击内联键盘按钮 |  |
| [complete_group_todo](https://snowluma.github.io/zh/docs/api/extended/complete_group_todo) | 完成群待办 |  |
| [create_collection](https://snowluma.github.io/zh/docs/api/extended/create_collection) | 创建收藏（未实现） |  |
| [create_flash_task](https://snowluma.github.io/zh/docs/api/extended/create_flash_task) | 创建闪传任务 |  |
| [delete_custom_face](https://snowluma.github.io/zh/docs/api/extended/delete_custom_face) | 删除收藏表情 |  |
| [delete_essence_msg](https://snowluma.github.io/zh/docs/api/extended/delete_essence_msg) | 移除精华消息 |  |
| [delete_flash_file](https://snowluma.github.io/zh/docs/api/extended/delete_flash_file) | 删除闪传文件 |  |
| [delete_group_folder](https://snowluma.github.io/zh/docs/api/extended/delete_group_folder) | 删除群文件夹 |  |
| [download_file](https://snowluma.github.io/zh/docs/api/extended/download_file) | 下载文件（url 或 base64）到 data/downloads |  |
| [download_fileset](https://snowluma.github.io/zh/docs/api/extended/download_fileset) | 解析闪传文件下载直链（不下载，由调用方实现下载） |  |
| [fetch_custom_face](https://snowluma.github.io/zh/docs/api/extended/fetch_custom_face) | 获取自定义表情（url 或 emoji_id） | 只读 |
| [fetch_custom_face_detail](https://snowluma.github.io/zh/docs/api/extended/fetch_custom_face_detail) | 获取自定义表情详情 | 只读 |
| [fetch_emoji_like](https://snowluma.github.io/zh/docs/api/extended/fetch_emoji_like) | 获取表情回应用户（NapCat 分页） | 只读 |
| [fetch_ptt_text](https://snowluma.github.io/zh/docs/api/extended/fetch_ptt_text) | 获取语音转文字结果（别名 get_ptt_text、get_record_text） | 只读 |
| [forward_friend_single_msg](https://snowluma.github.io/zh/docs/api/extended/forward_friend_single_msg) | 转发单条消息给好友 |  |
| [forward_group_single_msg](https://snowluma.github.io/zh/docs/api/extended/forward_group_single_msg) | 转发单条消息到群 |  |
| [friend_poke](https://snowluma.github.io/zh/docs/api/extended/friend_poke) | 好友拍一拍 |  |
| [get_ai_characters](https://snowluma.github.io/zh/docs/api/extended/get_ai_characters) | 获取 AI 语音角色 | 只读 |
| [get_ai_record](https://snowluma.github.io/zh/docs/api/extended/get_ai_record) | 生成 AI 语音 |  |
| [get_clientkey](https://snowluma.github.io/zh/docs/api/extended/get_clientkey) | 获取 clientkey | 只读 |
| [get_collection_list](https://snowluma.github.io/zh/docs/api/extended/get_collection_list) | 获取收藏列表 | 只读 |
| [get_cookies](https://snowluma.github.io/zh/docs/api/extended/get_cookies) | 获取 Cookies | 只读 |
| [get_credentials](https://snowluma.github.io/zh/docs/api/extended/get_credentials) | 获取凭证（cookies + token + csrf_token） | 只读 |
| [get_csrf_token](https://snowluma.github.io/zh/docs/api/extended/get_csrf_token) | 获取 CSRF 令牌 | 只读 |
| [get_doubt_friends_add_request](https://snowluma.github.io/zh/docs/api/extended/get_doubt_friends_add_request) | 获取可疑好友申请 | 只读 |
| [get_emoji_likes](https://snowluma.github.io/zh/docs/api/extended/get_emoji_likes) | 获取表情回应用户 | 只读 |
| [get_essence_msg_list](https://snowluma.github.io/zh/docs/api/extended/get_essence_msg_list) | 获取精华消息列表 | 只读 |
| [get_file](https://snowluma.github.io/zh/docs/api/extended/get_file) | 获取文件信息（仅图片/语音缓存；群文件请用 get_group_file_url） | 只读 |
| [get_fileset_id](https://snowluma.github.io/zh/docs/api/extended/get_fileset_id) | 从 QQ 闪传分享码或官方分享链接获取 fileset_id | 只读 |
| [get_fileset_info](https://snowluma.github.io/zh/docs/api/extended/get_fileset_info) | 获取文件集信息 |  |
| [get_flash_file_list](https://snowluma.github.io/zh/docs/api/extended/get_flash_file_list) | 获取闪传文件列表 |  |
| [get_flash_file_url](https://snowluma.github.io/zh/docs/api/extended/get_flash_file_url) | 获取闪传文件链接 |  |
| [get_forward_msg](https://snowluma.github.io/zh/docs/api/extended/get_forward_msg) | 获取合并转发消息（id 或 message_id） | 只读 |
| [get_friend_msg_history](https://snowluma.github.io/zh/docs/api/extended/get_friend_msg_history) | 获取好友消息历史（无锚点时从服务器获取最新双向记录） | 只读 |
| [get_friends_with_category](https://snowluma.github.io/zh/docs/api/extended/get_friends_with_category) | 获取分组好友列表 | 只读 |
| [get_group_at_all_remain](https://snowluma.github.io/zh/docs/api/extended/get_group_at_all_remain) | 获取群 @全体成员 剩余次数 | 只读 |
| [get_group_detail_info](https://snowluma.github.io/zh/docs/api/extended/get_group_detail_info) | 获取群详细信息 | 只读 |
| [get_group_file_system_info](https://snowluma.github.io/zh/docs/api/extended/get_group_file_system_info) | 获取群文件系统信息 | 只读 |
| [get_group_ignore_add_request](https://snowluma.github.io/zh/docs/api/extended/get_group_ignore_add_request) | 获取被忽略的入群请求（NapCat） | 只读 |
| [get_group_ignored_notifies](https://snowluma.github.io/zh/docs/api/extended/get_group_ignored_notifies) | 获取被过滤的入群请求 | 只读 |
| [get_group_info_ex](https://snowluma.github.io/zh/docs/api/extended/get_group_info_ex) | 获取群信息（扩展） | 只读 |
| [get_group_msg_history](https://snowluma.github.io/zh/docs/api/extended/get_group_msg_history) | 获取群消息历史 | 只读 |
| [get_group_shut_list](https://snowluma.github.io/zh/docs/api/extended/get_group_shut_list) | 获取群禁言列表 | 只读 |
| [get_group_signed_list](https://snowluma.github.io/zh/docs/api/extended/get_group_signed_list) | 获取群今日打卡列表 | 只读 |
| [get_group_todo_list](https://snowluma.github.io/zh/docs/api/extended/get_group_todo_list) | 获取群待办列表 | 只读 |
| [get_image](https://snowluma.github.io/zh/docs/api/extended/get_image) | 获取图片信息 | 只读 |
| [get_mini_app_ark](https://snowluma.github.io/zh/docs/api/extended/get_mini_app_ark) | 获取小程序卡片 ark | 只读 |
| [get_msg_emoji_likes](https://snowluma.github.io/zh/docs/api/extended/get_msg_emoji_likes) | 获取一条消息的全部表情回应 | 只读 |
| [get_online_clients](https://snowluma.github.io/zh/docs/api/extended/get_online_clients) | 获取在线客户端 | 只读 |
| [get_profile_like](https://snowluma.github.io/zh/docs/api/extended/get_profile_like) | 获取资料点赞 | 只读 |
| [get_recent_contact](https://snowluma.github.io/zh/docs/api/extended/get_recent_contact) | 获取最近会话（占位） | 只读 |
| [get_record](https://snowluma.github.io/zh/docs/api/extended/get_record) | 获取语音信息；传 out_format 则服务端转码并附带 base64 | 只读 |
| [get_rkey](https://snowluma.github.io/zh/docs/api/extended/get_rkey) | 获取下载 rkey（别名 nc_get_rkey） | 只读 |
| [get_rkey_server](https://snowluma.github.io/zh/docs/api/extended/get_rkey_server) | 获取 rkey 服务器信息 | 只读 |
| [get_share_link](https://snowluma.github.io/zh/docs/api/extended/get_share_link) | 获取文件分享链接 |  |
| [get_unidirectional_friend_list](https://snowluma.github.io/zh/docs/api/extended/get_unidirectional_friend_list) | 获取单向好友列表 | 只读 |
| [group_poke](https://snowluma.github.io/zh/docs/api/extended/group_poke) | 群拍一拍 |  |
| [list_filesets](https://snowluma.github.io/zh/docs/api/extended/list_filesets) | 列出当前账号的所有闪传文件集 |  |
| [mark_group_msg_as_read](https://snowluma.github.io/zh/docs/api/extended/mark_group_msg_as_read) | 标记群消息已读 |  |
| [mark_msg_as_read](https://snowluma.github.io/zh/docs/api/extended/mark_msg_as_read) | 标记消息已读（群聊/私聊自动路由） |  |
| [mark_private_msg_as_read](https://snowluma.github.io/zh/docs/api/extended/mark_private_msg_as_read) | 标记私聊消息已读 |  |
| [modify_custom_face](https://snowluma.github.io/zh/docs/api/extended/modify_custom_face) | 修改收藏表情备注 |  |
| [move_custom_face_to_front](https://snowluma.github.io/zh/docs/api/extended/move_custom_face_to_front) | 收藏表情移到最前 |  |
| [nc_get_packet_status](https://snowluma.github.io/zh/docs/api/extended/nc_get_packet_status) | 获取 packet 状态（占位） | 只读 |
| [nc_get_user_status](https://snowluma.github.io/zh/docs/api/extended/nc_get_user_status) | 获取用户在线/扩展状态 | 只读 |
| [ocr_image](https://snowluma.github.io/zh/docs/api/extended/ocr_image) | OCR 图片（需图片 URL 或已缓存的图片 file_id） | 只读 |
| [rename_flash_file](https://snowluma.github.io/zh/docs/api/extended/rename_flash_file) | 重命名闪传文件 |  |
| [request_decrypt_key](https://snowluma.github.io/zh/docs/api/extended/request_decrypt_key) | 请求数据库解密密钥 |  |
| [send_ark_share](https://snowluma.github.io/zh/docs/api/extended/send_ark_share) | 分享用户/群 Ark 卡片（NapCat 标准名） |  |
| [send_flash_msg](https://snowluma.github.io/zh/docs/api/extended/send_flash_msg) | 发送闪传消息（私聊或群聊，引用 fileset_id） |  |
| [send_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_forward_msg) | 发送合并转发（按 message_type/群号自动路由） |  |
| [send_group_ai_record](https://snowluma.github.io/zh/docs/api/extended/send_group_ai_record) | 发送 AI 语音到群 |  |
| [send_group_ark_share](https://snowluma.github.io/zh/docs/api/extended/send_group_ark_share) | 分享群 Ark 卡片（NapCat 标准名） |  |
| [send_group_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_group_forward_msg) | 发送群合并转发 |  |
| [send_like](https://snowluma.github.io/zh/docs/api/extended/send_like) | 点赞 |  |
| [send_packet](https://snowluma.github.io/zh/docs/api/extended/send_packet) | 发送原始 SSO 包（cmd + hex data） |  |
| [send_poke](https://snowluma.github.io/zh/docs/api/extended/send_poke) | 拍一拍（群聊/私聊自动路由） |  |
| [send_private_forward_msg](https://snowluma.github.io/zh/docs/api/extended/send_private_forward_msg) | 发送私聊合并转发 |  |
| [send_tuwen_ark](https://snowluma.github.io/zh/docs/api/extended/send_tuwen_ark) | 发送图文 Ark 卡片（私聊/群聊） |  |
| [set_diy_online_status](https://snowluma.github.io/zh/docs/api/extended/set_diy_online_status) | 设置自定义在线状态 |  |
| [set_doubt_friends_add_request](https://snowluma.github.io/zh/docs/api/extended/set_doubt_friends_add_request) | 处理可疑好友申请 |  |
| [set_essence_msg](https://snowluma.github.io/zh/docs/api/extended/set_essence_msg) | 设置精华消息 |  |
| [set_friend_remark](https://snowluma.github.io/zh/docs/api/extended/set_friend_remark) | 设置好友备注 |  |
| [set_friends_category](https://snowluma.github.io/zh/docs/api/extended/set_friends_category) | 移动好友到指定分组 |  |
| [set_group_reaction](https://snowluma.github.io/zh/docs/api/extended/set_group_reaction) | 群聊表情回应 |  |
| [set_group_remark](https://snowluma.github.io/zh/docs/api/extended/set_group_remark) | 设置群备注 |  |
| [set_group_robot_add_option](https://snowluma.github.io/zh/docs/api/extended/set_group_robot_add_option) | 设置群机器人加群选项 |  |
| [set_group_sign](https://snowluma.github.io/zh/docs/api/extended/set_group_sign) | 群签到（别名 send_group_sign） |  |
| [set_group_todo](https://snowluma.github.io/zh/docs/api/extended/set_group_todo) | 设置群待办 |  |
| [set_input_status](https://snowluma.github.io/zh/docs/api/extended/set_input_status) | 设置输入状态 |  |
| [set_msg_emoji_like](https://snowluma.github.io/zh/docs/api/extended/set_msg_emoji_like) | 设置消息表情回应 |  |
| [set_online_status](https://snowluma.github.io/zh/docs/api/extended/set_online_status) | 设置在线状态 |  |
| [set_qq_avatar](https://snowluma.github.io/zh/docs/api/extended/set_qq_avatar) | 设置 QQ 头像 |  |
| [set_qq_profile](https://snowluma.github.io/zh/docs/api/extended/set_qq_profile) | 设置 QQ 资料 |  |
| [set_restart](https://snowluma.github.io/zh/docs/api/extended/set_restart) | 重启（不支持） |  |
| [set_self_longnick](https://snowluma.github.io/zh/docs/api/extended/set_self_longnick) | 设置个性签名（longNick/long_nick，严格 string） |  |
| [share_group_ex](https://snowluma.github.io/zh/docs/api/extended/share_group_ex) | 分享群 Ark 卡片 |  |
| [share_peer](https://snowluma.github.io/zh/docs/api/extended/share_peer) | 分享用户/群 Ark 卡片 |  |
| [trans_group_file](https://snowluma.github.io/zh/docs/api/extended/trans_group_file) | 转存群文件 |  |
| [translate_en2zh](https://snowluma.github.io/zh/docs/api/extended/translate_en2zh) | 英译中 | 只读 |
| [upload_forward_msg](https://snowluma.github.io/zh/docs/api/extended/upload_forward_msg) | 上传转发消息 |  |
| [upload_foward_msg](https://snowluma.github.io/zh/docs/api/extended/upload_foward_msg) | 上传转发消息（别名拼写） |  |

### 5.2 群管理（24）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [add_group_tag](https://snowluma.github.io/zh/docs/api/group-admin/add_group_tag) | 向某个群分类添加资料标签 |  |
| [delete_group_tag](https://snowluma.github.io/zh/docs/api/group-admin/delete_group_tag) | 从某个群分类移除资料标签 |  |
| [get_group_admin_permissions](https://snowluma.github.io/zh/docs/api/group-admin/get_group_admin_permissions) | 读取指定管理员的撤回、移除成员、每日移除上限及接收验证消息状态 | 只读 |
| [get_group_admin_settings](https://snowluma.github.io/zh/docs/api/group-admin/get_group_admin_settings) | 获取群管理设置的当前值 | 只读 |
| [get_group_tags](https://snowluma.github.io/zh/docs/api/group-admin/get_group_tags) | 读取某个群分类下的资料标签 | 只读 |
| [set_group_add_option](https://snowluma.github.io/zh/docs/api/group-admin/set_group_add_option) | 设置加群选项 |  |
| [set_group_admin](https://snowluma.github.io/zh/docs/api/group-admin/set_group_admin) | 设置/取消管理员 |  |
| [set_group_admin_permissions](https://snowluma.github.io/zh/docs/api/group-admin/set_group_admin_permissions) | 设置指定管理员的撤回和移除成员权限 |  |
| [set_group_admin_receive_verify](https://snowluma.github.io/zh/docs/api/group-admin/set_group_admin_receive_verify) | 设置指定管理员是否接收加群验证消息 |  |
| [set_group_anonymous](https://snowluma.github.io/zh/docs/api/group-admin/set_group_anonymous) | 匿名开关（未实现，返回 ok） |  |
| [set_group_anonymous_ban](https://snowluma.github.io/zh/docs/api/group-admin/set_group_anonymous_ban) | 匿名禁言（未实现，返回 ok） |  |
| [set_group_ban](https://snowluma.github.io/zh/docs/api/group-admin/set_group_ban) | 禁言群成员（duration=0 解除） |  |
| [set_group_card](https://snowluma.github.io/zh/docs/api/group-admin/set_group_card) | 设置群名片（空字符串清除） |  |
| [set_group_kick](https://snowluma.github.io/zh/docs/api/group-admin/set_group_kick) | 踢出群成员 |  |
| [set_group_kick_members](https://snowluma.github.io/zh/docs/api/group-admin/set_group_kick_members) | 批量踢出群成员 |  |
| [set_group_leave](https://snowluma.github.io/zh/docs/api/group-admin/set_group_leave) | 退群 |  |
| [set_group_member_invite_policy](https://snowluma.github.io/zh/docs/api/group-admin/set_group_member_invite_policy) | 设置群成员邀请策略 |  |
| [set_group_member_permissions](https://snowluma.github.io/zh/docs/api/group-admin/set_group_member_permissions) | 设置群成员权限（仅群主可改） |  |
| [set_group_name](https://snowluma.github.io/zh/docs/api/group-admin/set_group_name) | 设置群名 |  |
| [set_group_new_member_history_visibility](https://snowluma.github.io/zh/docs/api/group-admin/set_group_new_member_history_visibility) | 设置新成员是否可查看历史消息 |  |
| [set_group_portrait](https://snowluma.github.io/zh/docs/api/group-admin/set_group_portrait) | 设置群头像 |  |
| [set_group_search](https://snowluma.github.io/zh/docs/api/group-admin/set_group_search) | 设置群被搜索方式（群指纹 / 群号搜索开关） |  |
| [set_group_special_title](https://snowluma.github.io/zh/docs/api/group-admin/set_group_special_title) | 设置群头衔 |  |
| [set_group_whole_ban](https://snowluma.github.io/zh/docs/api/group-admin/set_group_whole_ban) | 全员禁言开关 |  |

### 5.3 信息（5）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [can_send_image](https://snowluma.github.io/zh/docs/api/system/can_send_image) | 能力查询结果 | 只读 |
| [can_send_record](https://snowluma.github.io/zh/docs/api/system/can_send_record) | 能力查询结果 | 只读 |
| [get_login_info](https://snowluma.github.io/zh/docs/api/system/get_login_info) | 当前登录账号的 QQ 号与昵称 | 只读 |
| [get_status](https://snowluma.github.io/zh/docs/api/system/get_status) | 运行状态（online / good / time） | 只读 |
| [get_version_info](https://snowluma.github.io/zh/docs/api/system/get_version_info) | 实现与协议版本信息 | 只读 |

### 5.4 群相册（9）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [cancel_group_album_media_like](https://snowluma.github.io/zh/docs/api/group-album/cancel_group_album_media_like) | 取消群相册图片/视频点赞 |  |
| [del_group_album_media](https://snowluma.github.io/zh/docs/api/group-album/del_group_album_media) | 删除群相册图片或视频 |  |
| [do_group_album_comment](https://snowluma.github.io/zh/docs/api/group-album/do_group_album_comment) | 群相册评论 |  |
| [get_group_album_list](https://snowluma.github.io/zh/docs/api/group-album/get_group_album_list) | 群相册列表 | 只读 |
| [get_group_album_media_list](https://snowluma.github.io/zh/docs/api/group-album/get_group_album_media_list) | 相册图片/视频列表及下一页分页游标 | 只读 |
| [get_qun_album_list](https://snowluma.github.io/zh/docs/api/group-album/get_qun_album_list) | NapCat 风格的相册列表封套 | 只读 |
| [set_group_album_media_like](https://snowluma.github.io/zh/docs/api/group-album/set_group_album_media_like) | 群相册图片/视频点赞 |  |
| [upload_image_to_qun_album](https://snowluma.github.io/zh/docs/api/group-album/upload_image_to_qun_album) | 上传图片到群相册 |  |
| [upload_video_to_qun_album](https://snowluma.github.io/zh/docs/api/group-album/upload_video_to_qun_album) | 上传视频到群相册 |  |

### 5.5 流式接口（6）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [clean_stream_temp_file](https://snowluma.github.io/zh/docs/api/stream/clean_stream_temp_file) | 清理流式传输临时文件（仅清理 stream 上传/下载目录） |  |
| [download_file_image_stream](https://snowluma.github.io/zh/docs/api/stream/download_file_image_stream) | 以流式方式下载图片（缓存图片 id / URL / stream 目录本地文件） |  |
| [download_file_record_stream](https://snowluma.github.io/zh/docs/api/stream/download_file_record_stream) | 以流式方式下载语音 |  |
| [download_file_stream](https://snowluma.github.io/zh/docs/api/stream/download_file_stream) | 以流式方式下载文件（stream 目录本地文件 / URL / 缓存媒体） |  |
| [test_download_stream](https://snowluma.github.io/zh/docs/api/stream/test_download_stream) | 测试下载流（推送 10 个数据帧，不触达 QQ） |  |
| [upload_file_stream](https://snowluma.github.io/zh/docs/api/stream/upload_file_stream) | 以流式分块方式上传文件到机器人本地 |  |

### 5.6 空间（26）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [comment_qzone](https://snowluma.github.io/zh/docs/api/qzone/comment_qzone) | 评论说说或回复指定评论（普通评论支持带图，楼中楼仅支持文字） |  |
| [comment_qzone_public_feed](https://snowluma.github.io/zh/docs/api/qzone/comment_qzone_public_feed) | 评论推荐动态，支持文本或上游富文本条目 |  |
| [delete_qzone_msg](https://snowluma.github.io/zh/docs/api/qzone/delete_qzone_msg) | 删除一条说说（QQ 空间，按 tid） |  |
| [delete_qzone_public_comment](https://snowluma.github.io/zh/docs/api/qzone/delete_qzone_public_comment) | 删除推荐动态的一条评论（需有权限） |  |
| [delete_qzone_public_reply](https://snowluma.github.io/zh/docs/api/qzone/delete_qzone_public_reply) | 删除推荐动态评论下的一条回复（需有权限） |  |
| [forward_qzone_public_feed](https://snowluma.github.io/zh/docs/api/qzone/forward_qzone_public_feed) | 将推荐动态转发到当前账号空间 |  |
| [get_qzone_feeds](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_feeds) | 获取 QQ 空间好友动态，支持结构化正文与游标分页 | 只读 |
| [get_qzone_msg_detail](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_msg_detail) | 获取说说详情与一页评论（含服务端内联回复） | 只读 |
| [get_qzone_msg_list](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_msg_list) | 获取说说列表（默认机器人自己的空间） | 只读 |
| [get_qzone_profile](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_profile) | 获取 QQ 空间名称和说明（默认当前账号） | 只读 |
| [get_qzone_public_capabilities](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_public_capabilities) | 读取当前账号的空友爱看入口与推权限 | 只读 |
| [get_qzone_public_comments](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_public_comments) | 继续读取推荐动态评论 | 只读 |
| [get_qzone_public_feed_detail](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_public_feed_detail) | 读取推荐动态详情及初始评论 | 只读 |
| [get_qzone_public_feeds](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_public_feeds) | 读取空友爱看推荐动态，支持独立游标分页 | 只读 |
| [get_qzone_public_replies](https://snowluma.github.io/zh/docs/api/qzone/get_qzone_public_replies) | 继续读取指定评论的回复 | 只读 |
| [like_qzone](https://snowluma.github.io/zh/docs/api/qzone/like_qzone) | 给一条说说点赞（QQ 空间） |  |
| [reply_qzone_public_feed](https://snowluma.github.io/zh/docs/api/qzone/reply_qzone_public_feed) | 回复推荐动态的评论或其中某条回复 |  |
| [send_qzone_msg](https://snowluma.github.io/zh/docs/api/qzone/send_qzone_msg) | 发表说说（纯文字或带图；传 images 自动上传；可设权限） |  |
| [set_qzone_ban](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_ban) | 拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单） |  |
| [set_qzone_msg_right](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_msg_right) | 修改一条已发说说的查看权限 |  |
| [set_qzone_profile](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_profile) | 修改当前账号的 QQ 空间名称或说明 |  |
| [set_qzone_public_comment_like](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_public_comment_like) | 点赞或取消赞推荐动态中的评论或回复 |  |
| [set_qzone_public_follow](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_public_follow) | 蹲或取消蹲推荐动态作者 |  |
| [set_qzone_public_like](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_public_like) | 点赞或取消赞推荐动态 |  |
| [set_qzone_public_upvote](https://snowluma.github.io/zh/docs/api/qzone/set_qzone_public_upvote) | 推或取消推空友爱看动态（独立于普通赞） |  |
| [unlike_qzone](https://snowluma.github.io/zh/docs/api/qzone/unlike_qzone) | 取消对一条说说的点赞（取消赞端点待真机核实） |  |

### 5.7 群文件（12）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [create_group_file_folder](https://snowluma.github.io/zh/docs/api/group-file/create_group_file_folder) | 创建群文件夹 |  |
| [delete_group_file](https://snowluma.github.io/zh/docs/api/group-file/delete_group_file) | 删除群文件 |  |
| [delete_group_file_folder](https://snowluma.github.io/zh/docs/api/group-file/delete_group_file_folder) | 删除群文件夹 |  |
| [get_group_file_url](https://snowluma.github.io/zh/docs/api/group-file/get_group_file_url) | 获取群文件下载链接 | 只读 |
| [get_group_files_by_folder](https://snowluma.github.io/zh/docs/api/group-file/get_group_files_by_folder) | 获取群子目录文件列表 | 只读 |
| [get_group_root_files](https://snowluma.github.io/zh/docs/api/group-file/get_group_root_files) | 获取群根目录文件列表 | 只读 |
| [get_private_file_url](https://snowluma.github.io/zh/docs/api/group-file/get_private_file_url) | 获取私聊文件下载链接 | 只读 |
| [move_group_file](https://snowluma.github.io/zh/docs/api/group-file/move_group_file) | 移动群文件 |  |
| [rename_group_file](https://snowluma.github.io/zh/docs/api/group-file/rename_group_file) | 重命名群文件 |  |
| [rename_group_file_folder](https://snowluma.github.io/zh/docs/api/group-file/rename_group_file_folder) | 重命名群文件夹 |  |
| [upload_group_file](https://snowluma.github.io/zh/docs/api/group-file/upload_group_file) | 上传群文件 |  |
| [upload_private_file](https://snowluma.github.io/zh/docs/api/group-file/upload_private_file) | 上传私聊文件 |  |

### 5.8 好友（3）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [delete_friend](https://snowluma.github.io/zh/docs/api/friend/delete_friend) | 删除好友 |  |
| [get_friend_list](https://snowluma.github.io/zh/docs/api/friend/get_friend_list) | 获取好友列表 | 只读 |
| [get_stranger_info](https://snowluma.github.io/zh/docs/api/friend/get_stranger_info) | 获取陌生人信息 | 只读 |

### 5.9 消息（6）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [delete_msg](https://snowluma.github.io/zh/docs/api/message/delete_msg) | 撤回消息 |  |
| [get_msg](https://snowluma.github.io/zh/docs/api/message/get_msg) | 获取消息 | 只读 |
| [send_custom_face](https://snowluma.github.io/zh/docs/api/message/send_custom_face) | 发送账号收藏表情（emoji_id 或 MD5），保留表情显示样式 |  |
| [send_group_msg](https://snowluma.github.io/zh/docs/api/message/send_group_msg) | 发送群消息 |  |
| [send_msg](https://snowluma.github.io/zh/docs/api/message/send_msg) | 发送消息（按 message_type/群号 自动路由群聊或私聊） |  |
| [send_private_msg](https://snowluma.github.io/zh/docs/api/message/send_private_msg) | 发送私聊消息 |  |

### 5.10 系统表情（4）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [fetch_face_entity](https://snowluma.github.io/zh/docs/api/sys-face/fetch_face_entity) | 按编号查询 QQ 系统表情 | 只读 |
| [fetch_super_face_id](https://snowluma.github.io/zh/docs/api/sys-face/fetch_super_face_id) | 判断 QQ 系统表情是否使用超级表情格式 | 只读 |
| [fetch_sys_faces](https://snowluma.github.io/zh/docs/api/sys-face/fetch_sys_faces) | 获取 QQ 系统表情目录 | 只读 |
| [search_sys_faces](https://snowluma.github.io/zh/docs/api/sys-face/search_sys_faces) | 搜索 QQ 系统表情 | 只读 |

### 5.11 群信息（7）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [get_group_honor_info](https://snowluma.github.io/zh/docs/api/group-info/get_group_honor_info) | 获取群荣誉信息 | 只读 |
| [get_group_info](https://snowluma.github.io/zh/docs/api/group-info/get_group_info) | 获取群信息 | 只读 |
| [get_group_list](https://snowluma.github.io/zh/docs/api/group-info/get_group_list) | 获取群列表 | 只读 |
| [get_group_member_info](https://snowluma.github.io/zh/docs/api/group-info/get_group_member_info) | 获取群成员信息 | 只读 |
| [get_group_member_list](https://snowluma.github.io/zh/docs/api/group-info/get_group_member_list) | 获取群成员列表 | 只读 |
| [get_group_share_link](https://snowluma.github.io/zh/docs/api/group-info/get_group_share_link) | 获取群分享链接 | 只读 |
| [get_group_system_msg](https://snowluma.github.io/zh/docs/api/group-info/get_group_system_msg) | 获取群系统消息 | 只读 |

### 5.12 请求（2）

| 动作 | 说明 | 只读 |
| --- | --- | --- |
| [set_friend_add_request](https://snowluma.github.io/zh/docs/api/request/set_friend_add_request) | 处理好友添加请求 |  |
| [set_group_add_request](https://snowluma.github.io/zh/docs/api/request/set_group_add_request) | 处理加群请求 |  |

---

## 6. 相关文档

- 配置参考（端口、access token、适配器）：<https://snowluma.github.io/zh/docs/guide/configuration>
- 对接机器人（MaiBot / AstrBot / NoneBot）：<https://snowluma.github.io/zh/docs/guide/connect-bot>
- MCP 接入：<https://snowluma.github.io/zh/docs/mcp>
- TypeScript SDK：<https://snowluma.github.io/zh/docs/sdk>
- 整站 Markdown 导出（官方）：<https://snowluma.github.io/llms-full.txt>
- 动作目录（官方，机器可读 JSON）：<https://snowluma.github.io/api/catalog.json>
