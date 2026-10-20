# OneBot · cortico-world-onebot

让桌宠使用 QQ。连接到你的 NapCat 或 SnowLuma，然后在 QQ 上和 TA 聊天吧。

支持所有 OneBot v11 正向 WebSocket 实现：NapCat、SnowLuma、LLOneBot、Lagrange.OneBot 等。

## 功能

装好后，桌宠会多出五个工具，覆盖几乎所有 QQ 功能：

| 工具 | 作用 |
| --- | --- |
| `onebot_actions` | 搜索和查看所有可用功能（约 200 个） |
| `onebot_call` | 调用任意功能：发消息、发图、撤回、群管…… |
| `onebot_events` | 查看历史事件和通知 |
| `onebot_view_image` | 下载图片给模型查看 |
| `onebot_status` | 查看连接状态和配置 |

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 6`），只补一个 `onebot` 世界。

连上之后，控制台会显示对端的名字（例如 `snowluma：蒂仆希可`），而不是笼统的“已连接”。

## 安装

包目录就是你现在看的这个目录。三种装法，选一种：

**A. 控制台里装（推荐）**

设置 → 扩展 → 安装本地扩展，把本目录选给它。

**B. 命令行装**

在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add "D:\path\to\cortico-world-onebot" --ignore-workspace
```

它会往 `extensions/package.json` 的 `dependencies` 里写一条 `link:` 路径并连到 `node_modules/`。

**C. 手工连**

把 `data/extensions/node_modules/cortico-world-onebot` 做成指向本目录的目录联接，
并自己在 `extensions/package.json` 里加 `"cortico-world-onebot": "link:D:\\path\\to\\cortico-world-onebot"`。

**装完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在
`config.json` 的 `worlds.onebot.enabled` 上打开（控制台里也有这个开关），
五个工具才会挂给桌宠。

### 一份能用的 `worlds.onebot` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里，最小可用的一段：

```json
{
  "worlds": {
    "onebot": {
      "enabled": true,
      "implementation": "auto",
      "wsUrl": "ws://127.0.0.1:3001",
      "token": "",
      "actions": {
        "disabled": "set_restart, clean_cache, bot_exit",
        "writePolicy": "confirm"
      },
      "events": {
        "deliver": "*",
        "mute": "meta_event/*",
        "drop": "meta_event/heartbeat"
      },
      "images": {
        "download": true
      }
    }
  }
}
```

`token` 也可以放在 `ONEBOT_TOKEN` 环境变量里，环境变量优先。

## 配置

都在 `worlds.onebot` 段。action/event/image 策略改了就地生效；`wsUrl` 和 `token` 改完需要重启。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否挂载本 World |
| `implementation` | `auto` | `auto` = 连上后按 `app_name` 选目录；也可写 `snowluma` / `napcat` / `onebot11` 强制指定 |
| `wsUrl` | `ws://127.0.0.1:3001` | 实现的正向 WebSocket 地址（默认值是 SnowLuma 的端口） |
| `token` | 空 | Access token；也可用 `ONEBOT_TOKEN` 环境变量 |
| `actions.disabled` | `set_restart, clean_cache, bot_exit, send_packet` | 禁用的 action；逗号/换行分隔，支持精确名、别名、`*` 和 `category:分类名` |
| `actions.disabledCategories` | 空 | 按 catalog 分类禁用，例如 `群管理` |
| `actions.writePolicy` | `confirm` | `confirm` = 写操作要 `confirm:true`；`allow` = 直接执行；`deny` = 全部拒绝 |
| `actions.readOnly` | `false` | 只允许 catalog 标记为 `readOnly` 的 action |
| `events.deliver` | `*` | 归档并唤醒；逗号/换行分隔，支持 `*` |
| `events.mute` | `meta_event/*` | 归档但不唤醒，仍可用 `onebot_events` 查 |
| `events.drop` | `meta_event/heartbeat` | 完全不收；优先级高于 mute 和 deliver |
| `images.download` | `true` | 收到消息时下载图片，作为 `blobs` 交给模型 |
| `images.timeoutMs` | `10000` | 单张图片下载时限 |
| `images.maxImageBytes` | `10485760` | 单张图片字节上限 |
| `images.maxPerMessage` | `4` | 单条消息最多自动下载几张 |
| `maxEventChars` | `4000` | 非消息事件正文上限；原始 JSON 仍在 `meta.raw` |

### 匹配规则

```text
set_group_*                 所有群管理 action
category:群管理             整个分类
notice/group_*              所有群通知
message/*                   群聊和私聊消息
meta_event/*                所有 meta 事件
```

被禁用的 action 不会出现在 `onebot_actions` 的查询结果里，也查不到它的文档——对模型来说它等同于不存在。配置本身在控制台和 `config.json` 里照常可见。

## 密钥

`token` 两种填法：

- 直接写进 `config.json` 的 `worlds.onebot.token`；
- 或写进部署 `.env` 的 `ONEBOT_TOKEN=...`，环境变量优先，重启生效。

## Action 面

### `onebot_actions`

不传参数：列出 catalog 的分类。

```json
{ "query": "send" }
{ "name": "send_group_msg" }
{ "category": "消息" }
```

`name` 返回完整 catalog entry 和 `inputSchema`。不确定参数时先查这个。

### `onebot_call`

调用任意 OneBot action：

```json
{
  "action": "send_group_msg",
  "params": { "group_id": 123456, "message": "hello" }
}
```

写操作需要 `confirm: true`：

```json
{
  "action": "send_group_msg",
  "params": { "group_id": 123456, "message": "hello" },
  "confirm": true
}
```

只读 action（catalog 里 `readOnly: true`）直接执行，不需要确认。

富消息直接传 OneBot segment 数组：

```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 123456,
    "message": [
      { "type": "text", "data": { "text": "看这个 " } },
      { "type": "image", "data": { "file": "https://example.com/a.png" } }
    ]
  },
  "confirm": true
}
```

转发：

```json
{
  "action": "send_group_forward_msg",
  "params": {
    "group_id": 123456,
    "messages": [
      {
        "type": "node",
        "data": {
          "user_id": 10001,
          "nickname": "A",
          "content": [{ "type": "text", "data": { "text": "hi" } }]
        }
      }
    ]
  },
  "confirm": true
}
```

### 关于 `delete_msg`

`delete_msg` 返回 `{ status: "ok" }` 只表示 OneBot 把撤回包发出去了，**不代表 QQ 服务端真的撤回了**。群聊里撤回别人的消息需要 bot 是管理员/群主，并受 QQ 的撤回时限限制；服务端拒绝时，OneBot 仍可能回 ok。不要仅凭这个回执声称“已撤回”，应以 `notice/group_recall` 事件或对方确认作为结果。`onebot_call` 会在 `delete_msg` 的回执里附一条 `note`。

## Event 面

- `onebot.message`：QQ 消息。正文是一行可读文本，`meta.raw` 是原始事件，`meta.conv` 是 `{kind,id}`。消息里的图片在模型接受 `image/*` 时会自动下载并以 `blobs` 附加；否则保留 `[图片]` 占位，可用 `onebot_view_image` 补看。
- `onebot.event`：其他 OneBot 事件（notice/request/meta_event 等）。正文是 `[kind] <json>`，`meta.raw` 是原始事件。
- `onebot.connection`：连接建立/断开。

没有 `group_recall`、`poke`、`group_increase` 这些专用事件类型。它们都在 `onebot.event` 里，`meta.kind` 区分；想让某类事件唤醒模型，改 `events.deliver` 即可，不用改代码。

### `onebot_events`

按 kind / 时间读事件库：

```json
{ "kind": "notice/*", "limit": 20 }
{ "kind": "message/group", "since": "2026-10-18T00:00:00Z" }
```

`raw` 默认 `true`，返回 `meta.raw` 里的原始 OneBot 事件；设为 `false` 只返回摘要。

### `onebot_view_image`

把一张图下载成模型能看的附件：

```json
{ "url": "https://example.com/a.png" }
{ "file_id": "OneBot 缓存的图片 id" }
```

它内部会先 `get_image` 把 `file_id` 解析成 URL，再下载；不需要 shell。

## 控制台页

除了配置表单和提示词页，还有一个**动作目录**页签：

- 上半部分列出当前生效的目录：实现、对端识别结果、目录来源与版本、动作数、分类数、被禁用数；
- 下半部分是「更新动作」按钮：填好目录地址（NapCat 默认 `http://127.0.0.1:6099/api/Debug/schemas`）和 WebUI token，点一下就从运行中的实现重新拉一份，落盘到 `src/catalogs/<实现>.json` 并在当前进程里立即生效。

拉不到就保持现状，只把错误显示在按钮下方。不需要终端，也不需要重启。

## 维护者：重新生成目录

随包的三份目录是快照。实现对端加了新 action、或者要支持新实现时，在仓库里重新生成一次（普通使用不需要这一步）：

```powershell
# NapCat：直接读它的源码，不需要跑起来
node tools/gen-napcat-catalog.mjs --from "D:\path\to\NapCatQQ"

# 任意实现：从运行中的实例或文件同步
npm run sync-catalog -- --impl napcat --from http://127.0.0.1:6099/api/Debug/schemas --token "<WebUI token>"
npm run sync-catalog -- --impl snowluma --from "D:\path\to\SnowLuma"
```

`sync-catalog` 的 `--from` 接受文件、目录或 URL，能认出本包格式、SnowLuma 的 `catalog.json`、NapCat 的 `/api/Debug/schemas` 三种形状；`gen-napcat-catalog` 走源码，不用装 NapCat、不用开端口。

NapCat 不声明哪些 action 是只读的，两个工具都按命名归类（`get_*` / `can_send_*` / `fetch_*` 等算只读），其余一律按写操作处理——判错方向是“多要一次确认”，不是“绕过确认”。

生成后跑 `npm run check` 与 `npm test`，再发版。

## 自检

离线检查（不联网、不碰安装目录）：

```powershell
npm run selfcheck
```

单元与集成测试（集成测试会在本机起一个假 OneBot WS 和图片 HTTP 服务）：

```powershell
npm test
```

用**这套安装里的框架判据**真跑一遍装配检查（manifest 解析、dry-mount、工具名冲突、配置路径）：

```powershell
$env:COOPANION_APP_ROOT = "D:\Coopanion\resources\app"
node --experimental-transform-types tools/drymount.mts
```

## 目录结构

```
cortico-world-onebot/
├─ package.json        # cortico: { kind: world, api: 6, displayName: "OneBot", describe: describe.json }
├─ describe.json       # 自描述：工具、事件与提示词（npm run describe 生成）
├─ CHANGELOG.md        # 每个版本一节，扩展市场按版本显示更新说明
├─ src/
│  ├─ index.js         # 默认导出 WorldDefinition
│  ├─ definition.js    # 默认配置、预检、实例工厂、自描述
│  ├─ config.js        # 配置默认值、WebUI 表单、文案
│  ├─ catalog.js       # 目录加载：按实现选文件、兜底标准目录
│  ├─ catalog-update.js # 目录的拉取、归一化与落盘（面板与脚本共用）
│  ├─ webui/client.js  # 「动作目录」页签的浏览器 bundle
│  ├─ catalogs/
│  │  ├─ onebot11.json # 本包维护的 OneBot v11 标准 action
│  │  ├─ snowluma.json # 从 @snowluma/mcp 生成的 SnowLuma 目录
│  │  └─ napcat.json   # 本机生成（sync-catalog --impl napcat）
│  ├─ policy.js        # disabled / mute / drop 匹配
│  ├─ render.js        # 消息可读化 + 事件兜底
│  ├─ images.js        # 图片下载与 MIME
│  ├─ implementations.js # 按 get_version_info 识别对端实现
│  ├─ driver.js        # OneBot WS、echo、重连、超时
│  ├─ world.js         # 五个工具 + 事件泵 + promptDocs 声明
│  └─ ENV_PROMPT.md    # 环境提示词模板（可被部署目录 worlds/onebot/ENV_PROMPT.md 覆盖）
├─ tools/
│  ├─ check.mjs        # 离线自检
│  ├─ describe.mjs     # 生成 describe.json
│  ├─ sync-catalog.mjs # 从本机实现同步 catalog
│  ├─ gen-napcat-catalog.mjs # 从 NapCatQQ 源码生成 catalog（维护者）
│  └─ drymount.mts     # 框架 dry-mount 检查
└─ test/
   ├─ policy.test.mjs
   ├─ render.test.mjs
   ├─ catalog.test.mjs
   ├─ panel.test.mjs
   └─ integration.test.mjs
```

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## License

本包代码 MIT。`src/catalogs/onebot11.json` 与 `src/catalogs/snowluma.json` 随包发布；其他实现的目录由使用者在本机用 `sync-catalog` 生成到 `src/catalogs/<impl>.json`，不进入 Git/npm。

非官方扩展：与 Coopanion / cortico / 各 OneBot 实现的作者无关。
