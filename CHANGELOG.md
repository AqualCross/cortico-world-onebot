# 更新日志 · cortico-world-onebot

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.2.0

- 新增「接收的会话」：默认接收全部（`conversations.receive = "*"`）。改成名单后，未接收会话的消息、撤回、戳一戳等通知在事件泵入口直接丢弃，不渲染、不下载图片、不写事件库、不唤醒模型。
- 控制台新增「接收的会话」页签：从群列表和好友列表勾选，支持搜索、全选与刷新；保存后立即生效。全选存 `*`，包含以后新增的会话。
- 新增 `onebot_receive` 工具：`list` 查看名单与可选会话，`set` 整体替换，`add` / `remove` 增减；写入遵循 `actions.readOnly` 与 `actions.writePolicy`。
- 未接收的会话需要历史时，用 `onebot_call` 调 `get_group_msg_history` / `get_friend_msg_history` 查 QQ 自己的记录。
- `onebot_status` 增加当前接收名单；群通知和请求的 `meta.conv` 也带上会话。
- 移除与框架 World 开关重复的 `enabled` 配置项；World 的启停只由框架控制。
- 默认值 `*` 保持原有行为，升级后不会少收消息。

## 0.1.1

- 修复详情页徽标未同步：目录更新后刷新连接与 action 数量，并定期同步连接状态。

## 0.1.0

- 首个版本：通过 OneBot v11 正向 WebSocket 接入 OneBot 实现（SnowLuma、NapCat、LLOneBot、Lagrange 等），覆盖全部 action 与 event。
- 一个通用 `onebot_call` dispatcher，不按 action 建专用工具。
- action 目录按实现分开：`implementation` 默认 `auto`，连上后按 `get_version_info` 的 `app_name` 选目录，认不出来用 OneBot v11 标准目录；也可以写死 `snowluma` / `napcat` / `onebot11`。
- 三份目录随包发布，装完即用，不需要跑脚本：SnowLuma 200 个 action、NapCat 177 个、OneBot v11 标准 36 个。目录是快照，实现对端新增的 action 要等新版本或自己重新生成。
- 控制台的「动作目录」页签：显示当前目录（实现、来源、版本、动作数、分类数、禁用数），并有一个「更新动作」按钮，填好目录地址和 token 点一下就重新拉取，落盘后在当前进程立即生效，不用开终端也不用重启。
- `onebot_actions`：不传参列分类，按关键词/分类查 action，给 `name` 返回完整 JSON Schema。被禁用的 action 不出现在结果里，也查不到文档——对模型来说等同于不存在。
- `onebot_events`：按 kind / 时间查归档事件，包含对话里已经看不到的历史。
- `onebot_view_image`：把图片 URL 或图片 `file_id` 下载成模型可看的附件。
- `onebot_status`：连接、账号、catalog 来源、写权限与事件策略。
- 控制台连接徽标显示实际连上的实现与账号（例如 `snowluma：蒂仆希可`），实现名取自 `get_version_info` 的 `app_name`；识别不出来时显示 `onebot11`。
- 默认全开，用 `actions.disabled` / `disabledCategories` / `events.mute` / `events.drop` 做配置减法；默认只禁用 `set_restart`、`clean_cache`、`bot_exit`。
- 写操作默认 `writePolicy: "confirm"`，需要 `confirm: true`；支持全局 `readOnly`。
- 消息里的图片会自动下载为 `blobs`；图片过大、URL 过期或下载失败时保留 `[图片]` 占位。
- 事件兜底：非消息 OneBot 事件统一为 `onebot.event`，原始 JSON 保存在 `meta.raw`，没有 per-event handler。
- `delete_msg` 回执附带说明：`ok` 只代表撤回请求已发出，不代表 QQ 服务端已撤回。
- 需要扩展契约 world 6（Coopanion v0.2.0 / 内嵌 Cortico v0.2.0 及以上）。
