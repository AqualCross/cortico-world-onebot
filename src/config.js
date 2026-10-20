/**
 * 配置段与文案。
 *
 * 这里只声明默认值和 WebUI 表单；运行中的 World 每次都从活配置读取，
 * 所以 actions/events 策略改完立即生效，不需要重写代码。
 */
import { IMPLEMENTATIONS } from './catalog.js';

export const ID = 'onebot';
export const LABEL = 'OneBot';

export const EVENT_MESSAGE = 'onebot.message';
export const EVENT_RAW = 'onebot.event';
export const EVENT_CONNECTION = 'onebot.connection';

/**
 * 默认禁用：会让 bot 自己下线、清运行态，或者绕过 action 层直接发原始包的动作。
 * 名单是跨实现的并集——别的实现里不存在的名字本来就不生效。
 * 退群、删好友这类对外操作不在这里：它们由 writePolicy=confirm 拦一道确认。
 */
export const DEFAULT_DISABLED_ACTIONS = [
  'set_restart',
  'clean_cache',
  'bot_exit',
  'send_packet',
].join(', ');

export const DEFAULTS = Object.freeze({
  enabled: false,
  /** auto = 连上后按 get_version_info 识别实现；也可写 snowluma / napcat / onebot11 */
  implementation: 'auto',
  /** OneBot 实现的正向 WebSocket */
  wsUrl: 'ws://127.0.0.1:3001',
  /** 也可用 ONEBOT_TOKEN 环境变量；环境变量优先。 */
  token: '',
  actions: {
    /** 逗号/换行分隔；支持 * 和 category:分类名 */
    disabled: DEFAULT_DISABLED_ACTIONS,
    /** 逗号/换行分隔；按 catalog 的 category 匹配 */
    disabledCategories: '',
    /** confirm = 写操作必须带 confirm:true；allow = 直接执行；deny = 全部拒绝 */
    writePolicy: 'confirm',
    /** 只允许 catalog 标记为 readOnly 的 action */
    readOnly: false,
  },
  events: {
    /** 归档并唤醒 */
    deliver: '*',
    /** 归档但不唤醒，仍可用 onebot_events 查 */
    mute: 'meta_event/*',
    /** 完全丢弃 */
    drop: 'meta_event/heartbeat',
  },
  images: {
    /** 收到消息时自动下载图片，作为 blobs 交给模型 */
    download: true,
    timeoutMs: 10000,
    maxImageBytes: 10 * 1024 * 1024,
    maxPerMessage: 4,
  },
  /** 非消息事件的正文上限；原始 JSON 仍在 meta.raw 里 */
  maxEventChars: 4000,
  apiTimeoutMs: 10000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
});

/** 兼容数组和字符串；WebUI 的 string 字段用逗号/换行分隔。 */export function patterns(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean);
}

/** 把活配置补成完整形状；不复制，保证热改能被读到。 */
export function readConfig(cfg = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const actions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
  const events = raw.events && typeof raw.events === 'object' ? raw.events : {};
  const images = raw.images && typeof raw.images === 'object' ? raw.images : {};
  const writePolicy = ['confirm', 'allow', 'deny'].includes(actions.writePolicy)
    ? actions.writePolicy
    : DEFAULTS.actions.writePolicy;
  const implementation = IMPLEMENTATIONS.includes(raw.implementation)
    ? raw.implementation
    : DEFAULTS.implementation;
  return {
    ...DEFAULTS,
    ...raw,
    implementation,
    actions: { ...DEFAULTS.actions, ...actions, writePolicy },
    events: { ...DEFAULTS.events, ...events },
    images: { ...DEFAULTS.images, ...images },
  };
}

const ZH = {
  label: 'OneBot',
  lamp: 'OneBot',
  connection: '连接',
  actions: 'Action',
  connected: '已连接',
  disconnected: '未连接',
  connectedAs: (impl, who) => (who ? `${impl}：${who}` : impl),
  catalogPanelTitle: '动作目录',
  catalogPanelDesc: '看当前生效的 action 目录，需要时从实现对端重新拉一份。',
  promptTitle: '提示词',
  prompt: '',
  config: {
    title: 'OneBot',
    description: '通过 OneBot v11 正向 WebSocket 接入任意实现；action 目录来自本机同步的快照。',
    enabled: '启用 OneBot',
    enabledDesc: '打开后挂载本 World，连接 worlds.onebot.wsUrl。',
    implementation: '实现',
    implementationDesc: 'auto = 连上后按 get_version_info 识别对端实现，自动换用对应 action 目录；也可以指定 snowluma / napcat / onebot11 强制使用某份目录。',
    wsUrl: 'OneBot WS 地址',
    wsUrlDesc: '实现的正向 WebSocket 地址，默认 ws://127.0.0.1:3001（SnowLuma 的端口）。修改后需重启。',
    token: 'Access token',
    tokenDesc: '可留空；也可用 ONEBOT_TOKEN 环境变量。修改后需重启。',
    disabledActions: '禁用的 action',
    disabledActionsDesc: '逗号/换行分隔。支持精确名、别名、* 通配和 category:分类名。默认禁用 set_restart、clean_cache、bot_exit、send_packet。',
    disabledCategories: '禁用的分类',
    disabledCategoriesDesc: '逗号/换行分隔，按 action catalog 的 category 匹配，例如「群管理」。',
    writePolicy: '写操作策略',
    writePolicyDesc: 'confirm = 写操作必须带 confirm:true；allow = 直接执行；deny = 全部拒绝。',
    readOnly: '只读模式',
    readOnlyDesc: '只允许 catalog 标记为 readOnly 的 action。',
    deliverEvents: '唤醒的事件',
    deliverEventsDesc: '逗号/换行分隔，支持 *；匹配 kind，例如 message/group。',
    muteEvents: '只归档的事件',
    muteEventsDesc: '匹配的事件会写入事件库但不唤醒模型，可用 onebot_events 查。',
    dropEvents: '丢弃的事件',
    dropEventsDesc: '匹配的事件完全不收；优先级高于 mute 和 deliver。',
    maxEventChars: '事件正文上限',
    maxEventCharsDesc: '非消息事件正文的最大字符数；原始 JSON 仍保存在 meta.raw。',
    downloadImages: '自动下载图片',
    downloadImagesDesc: '收到消息时下载图片并作为附件交给模型；关闭后只显示 [图片] 占位。',
    imageTimeout: '图片下载超时',
    imageTimeoutDesc: '单张图片的下载时限，单位毫秒。',
    imageMaxBytes: '图片大小上限',
    imageMaxBytesDesc: '单张图片的字节上限；超过时只保留占位，不附加图片。',
  },
};

const EN = {
  label: 'OneBot',
  lamp: 'OneBot',
  connection: 'Connection',
  actions: 'Actions',
  connected: 'connected',
  disconnected: 'disconnected',
  connectedAs: (impl, who) => (who ? `${impl}: ${who}` : impl),
  catalogPanelTitle: 'Action catalog',
  catalogPanelDesc: 'Shows the catalog in effect and re-fetches it from the implementation on demand.',
  promptTitle: 'Prompt',
  prompt: '',
  config: {
    title: 'OneBot',
    description: 'Any OneBot v11 implementation over a forward WebSocket; the action catalog comes from a local snapshot.',
    enabled: 'Enable OneBot',
    enabledDesc: 'Mount this World and connect to worlds.onebot.wsUrl.',
    implementation: 'Implementation',
    implementationDesc: 'auto = identify the implementation via get_version_info after connecting and load its action catalog; or force snowluma / napcat / onebot11.',
    wsUrl: 'OneBot WS URL',
    wsUrlDesc: 'Forward WebSocket address of the implementation; the default ws://127.0.0.1:3001 is SnowLuma\'s port. Restart after changing.',
    token: 'Access token',
    tokenDesc: 'Optional; ONEBOT_TOKEN takes precedence. Restart after changing.',
    disabledActions: 'Disabled actions',
    disabledActionsDesc: 'Comma/newline separated: exact name, alias, * glob, or category:<name>. Default: set_restart, clean_cache, bot_exit, send_packet.',
    disabledCategories: 'Disabled categories',
    disabledCategoriesDesc: 'Comma/newline separated; matches the catalog category, e.g. "Group admin".',
    writePolicy: 'Write policy',
    writePolicyDesc: 'confirm = writes need confirm:true; allow = execute directly; deny = reject all writes.',
    readOnly: 'Read-only mode',
    readOnlyDesc: 'Only actions marked readOnly in the catalog.',
    deliverEvents: 'Delivered events',
    deliverEventsDesc: 'Comma/newline separated; supports *. Matches event kind, e.g. message/group.',
    muteEvents: 'Archived-only events',
    muteEventsDesc: 'Matched events are stored but do not wake the model; query them with onebot_events.',
    dropEvents: 'Dropped events',
    dropEventsDesc: 'Matched events are not stored at all; takes precedence over mute and deliver.',
    maxEventChars: 'Event text cap',
    maxEventCharsDesc: 'Maximum characters for non-message event text; raw JSON stays in meta.raw.',
    downloadImages: 'Download images',
    downloadImagesDesc: 'Download images from incoming messages and attach them for the model; off leaves a [图片] placeholder.',
    imageTimeout: 'Image timeout',
    imageTimeoutDesc: 'Per-image download timeout in milliseconds.',
    imageMaxBytes: 'Image size cap',
    imageMaxBytesDesc: 'Per-image byte cap; larger images stay as a placeholder without an attachment.',
  },
};

export function text(language = 'zh') {
  return language === 'en' ? EN : ZH;
}

/** WebUI 的表单声明。数组在 WebUI 里不好编辑，所以统一用逗号分隔的字符串。 */
export function configGroup(language = 'zh') {
  const t = text(language).config;
  const K = `worlds.${ID}`;
  return {
    id: `world:${ID}`,
    owner: `world:${ID}`,
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        [`${K}.enabled`]: {
          type: 'boolean',
          title: t.enabled,
          description: t.enabledDesc,
          'x-hot': true,
        },
        [`${K}.implementation`]: {
          type: 'string',
          title: t.implementation,
          description: t.implementationDesc,
          enum: IMPLEMENTATIONS,
          'x-hot': true,
        },
        [`${K}.wsUrl`]: {
          type: 'string',
          title: t.wsUrl,
          description: t.wsUrlDesc,
          'x-hot': false,
        },
        [`${K}.token`]: {
          type: 'string',
          title: t.token,
          description: t.tokenDesc,
          'x-hot': false,
        },
        [`${K}.actions.disabled`]: {
          type: 'string',
          title: t.disabledActions,
          description: t.disabledActionsDesc,
          'x-hot': true,
        },
        [`${K}.actions.disabledCategories`]: {
          type: 'string',
          title: t.disabledCategories,
          description: t.disabledCategoriesDesc,
          'x-hot': true,
        },
        [`${K}.actions.writePolicy`]: {
          type: 'string',
          title: t.writePolicy,
          description: t.writePolicyDesc,
          enum: ['confirm', 'allow', 'deny'],
          'x-hot': true,
        },
        [`${K}.actions.readOnly`]: {
          type: 'boolean',
          title: t.readOnly,
          description: t.readOnlyDesc,
          'x-hot': true,
        },
        [`${K}.events.deliver`]: {
          type: 'string',
          title: t.deliverEvents,
          description: t.deliverEventsDesc,
          'x-hot': true,
        },
        [`${K}.events.mute`]: {
          type: 'string',
          title: t.muteEvents,
          description: t.muteEventsDesc,
          'x-hot': true,
        },
        [`${K}.events.drop`]: {
          type: 'string',
          title: t.dropEvents,
          description: t.dropEventsDesc,
          'x-hot': true,
        },
        [`${K}.maxEventChars`]: {
          type: 'integer',
          title: t.maxEventChars,
          description: t.maxEventCharsDesc,
          minimum: 200,
          maximum: 100000,
          multipleOf: 100,
          'x-hot': true,
        },
        [`${K}.images.download`]: {
          type: 'boolean',
          title: t.downloadImages,
          description: t.downloadImagesDesc,
          'x-hot': true,
        },
        [`${K}.images.timeoutMs`]: {
          type: 'integer',
          title: t.imageTimeout,
          description: t.imageTimeoutDesc,
          minimum: 1000,
          maximum: 60000,
          multipleOf: 1000,
          'x-suffix': 'ms',
          'x-hot': true,
        },
        [`${K}.images.maxImageBytes`]: {
          type: 'integer',
          title: t.imageMaxBytes,
          description: t.imageMaxBytesDesc,
          minimum: 65536,
          maximum: 104857600,
          multipleOf: 65536,
          'x-scale': 1048576,
          'x-suffix': 'MB',
          'x-hot': true,
        },
      },
    },
  };
}
