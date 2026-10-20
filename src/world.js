/**
 * OneBot World。
 *
 * 两个通用面：
 *   action —— 一个 onebot_call dispatcher + catalog 按需查文档；
 *   event  —— 一条 WS 全量收，message 可读化，其余压成一行 JSON 兜底。
 *
 * 没有任何 per-action 的 send_xxx / set_xxx 工具，也没有 per-event 的
 * group_recall / poke handler。新增能力只改 catalog 或配置。
 */
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS,
  EVENT_CONNECTION,
  EVENT_MESSAGE,
  EVENT_RAW,
  ID,
  configGroup,
  patterns,
  readConfig,
  text,
} from './config.js';
import { STANDARD_IMPL, loadCatalog } from './catalog.js';
import { normalizeCatalog, readCatalogSource, saveCatalog } from './catalog-update.js';
import { actionPolicy, eventPolicy, matcher } from './policy.js';
import { capText, compactJson, eventKind, renderMessage } from './render.js';
import { downloadImage, extensionForMime, imageSourcesFromMessage } from './images.js';
import { detectImplementation } from './implementations.js';
import { OneBotDriver } from './driver.js';

const MAX_ACTION_RESULT_CHARS = 20000;

/** 环境提示词模板：框架按 role=envPrompt 读它拼进 system 前缀，可被部署目录覆盖。 */
const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/**
 * action 回执的额外说明。不是 wrapper，只是把“协议端返回 ok ≠ 平台真的执行了”
 * 这类已知语义告诉模型；真正的权限判断仍在 OneBot / QQ 服务端。
 */
const ACTION_NOTES = {
  delete_msg:
    'OneBot ok only means the recall packet was sent; QQ may still reject it. '
    + 'In a group, recalling another member\'s message requires admin/owner and is limited by QQ\'s recall window. '
    + 'Do not claim success until a notice/group_recall event arrives or the user confirms.',
};

const fail = (message) => ({ text: message, failed: true });

export const ONEBOT_TOOL_DECLS = [
  {
    name: 'onebot_actions',
    tags: ['read'],
    description:
      'Look up OneBot actions. With no args it lists the catalog categories; '
      + 'query/category search the catalog; name returns one action\'s full docs and JSON Schema.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search action name, alias or summary.' },
        name: { type: 'string', description: 'Return the full catalog entry and inputSchema for this action or alias.' },
        category: { type: 'string', description: 'Filter by catalog category, e.g. 消息 or 群管理.' },
      },
    },
  },
  {
    name: 'onebot_call',
    tags: ['act'],
    description:
      'Call any OneBot action. Read-only actions run immediately; write actions require confirm=true.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action name or alias, e.g. send_group_msg or get_group_info.' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'The action params object. For send_* actions, message may be a string or OneBot segment array.',
        },
        confirm: { type: 'boolean', description: 'Set true to execute a write action.' },
        timeout_ms: { type: 'integer', description: 'Optional call timeout in milliseconds (1000-120000).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'onebot_events',
    tags: ['read'],
    description:
      'Read archived OneBot events by kind/time, including history that is no longer in the conversation. '
      + 'kind supports * (e.g. notice/*).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Event kind or glob: message/group, notice/group_recall, meta_event/*.' },
        since: { type: 'string', description: 'ISO 8601 lower bound, inclusive.' },
        until: { type: 'string', description: 'ISO 8601 upper bound, inclusive.' },
        limit: { type: 'integer', description: 'Maximum events to return (1-100, default 30).' },
        raw: { type: 'boolean', description: 'Include meta.raw. Default true; set false for a compact result.' },
      },
    },
  },
  {
    name: 'onebot_view_image',
    tags: ['read'],
    description:
      'Download an image and return it so you can see it. Use this when a message only shows '
      + '[图片], or when you have an image URL or OneBot file_id from get_image or onebot_events. '
      + 'Provide url, or file/file_id for a OneBot cached image.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) image URL.' },
        file: { type: 'string', description: 'A OneBot image file parameter (usually from an image segment).' },
        file_id: { type: 'string', description: 'A OneBot cached image file_id.' },
        timeout_ms: { type: 'integer', description: 'Optional download timeout in milliseconds.' },
      },
    },
  },
  {
    name: 'onebot_status',
    tags: ['read'],
    description:
      'OneBot connection, account, catalog, and current write/event policy.',
    parameters: { type: 'object', properties: {} },
  },
];

export class OneBotWorld {
  #cfg;
  #timezone;
  #host = null;
  #driver = null;
  #log = null;
  #lastError = '';
  #startedAt = '';
  #lastConnection = null;
  #catalog;
  #status = { connected: false, selfId: null, nickname: '', implementation: '' };

  constructor(opts = {}) {
    this.id = ID;
    this.#cfg = opts.cfg ?? {};
    this.#timezone = opts.timezone ?? '';
    this.#catalog = loadCatalog({ impl: implOf(readConfig(this.#cfg)) });
  }

  get #settings() {
    return readConfig(this.#cfg);
  }

  /**
   * 环境提示词模板没有占位符：连接状态由 onebot.connection 事件推送，
   * 账号与目录来源随时可用 onebot_status / onebot_actions 查。
   * 返回 null 会把整段从前缀删掉，所以是 {} 而不是 null。
   */
  envPromptVars() {
    return {};
  }

  webUi(language = 'zh') {
    const t = text(language);
    const s = this.#settings;
    const counts = this.#catalog.counts(actionPolicy(s));
    const connected = this.#driver?.connected === true;
    const idn = this.#driver?.identity;
    const impl = this.#status.implementation || detectImplementation(idn?.version).label;
    const who = idn?.nickname || (idn?.selfId != null ? String(idn.selfId) : '');
    const state = connected
      ? 'online'
      : (this.#driver ? (this.#lastError ? 'error' : 'loading') : 'offline');
    const hint = connected
      ? (who || t.connected)
      : (this.#lastError || (this.#driver ? 'connecting' : t.disconnected));
    return {
      label: t.label,
      lamps: [{ label: t.lamp, state, hint }],
      badges: [
        {
          label: t.connection,
          value: connected ? t.connectedAs(impl, who) : t.disconnected,
          tone: connected ? 'on' : 'off',
        },
        { label: t.actions, value: `${counts.enabled}/${counts.total}` },
      ],
      config: [configGroup(language)],
      panels: [{
        id: 'actions',
        title: t.catalogPanelTitle,
        description: t.catalogPanelDesc,
      }],
      invoke: (panel, method, args) => this.#invokePanel(panel, method, args ?? []),
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.promptTitle,
        description: t.prompt,
        path: ENV_PROMPT,
        role: 'envPrompt',
      }],
    };
  }

  /** 控制台「动作目录」面板的数据面：读状态、按需更新。 */
  async #invokePanel(panel, method, args) {
    if (panel !== 'actions') throw new Error(`unknown panel: ${panel}`);
    if (method === 'state') return this.#catalogState();
    if (method === 'update') return await this.#updateCatalog(args[0], args[1]);
    throw new Error(`unknown method: ${panel}.${method}`);
  }

  #catalogState() {
    const counts = this.#catalog.counts(actionPolicy(this.#settings));
    const idn = this.#driver?.identity;
    return {
      connected: this.#driver?.connected === true,
      impl: this.#catalog.impl,
      detected: this.#status.implementation || '',
      appVersion: String(idn?.version?.app_version ?? ''),
      source: this.#catalog.source,
      version: this.#catalog.version,
      actions: this.#catalog.total,
      categories: this.#catalog.categories.length,
      disabled: counts.disabled,
      defaultUrl: catalogUrlFor(this.#catalog.impl),
    };
  }

  async #updateCatalog(url, token) {
    const impl = this.#catalog.impl;
    const target = String(url ?? '').trim() || catalogUrlFor(impl);
    if (!target) throw new Error('no catalog source');
    const raw = await readCatalogSource(target, { token: String(token ?? '').trim() });
    const data = normalizeCatalog(raw, impl);
    let saved = '';
    try {
      saved = saveCatalog(data, impl);
    } catch (err) {
      this.#log?.warn?.('catalog save failed', { error: String(err) });
    }
    this.#catalog = loadCatalog({ impl });
    this.#log?.info?.('catalog updated', { impl, actions: this.#catalog.total, saved });
    return { ...this.#catalogState(), saved, updatedAt: data.generatedAt };
  }

  async start(host) {
    this.#host = host;
    this.#log = host.log ?? null;
    this.#startedAt = nowIso();
    this.#lastConnection = null;
    this.#lastError = '';

    const s = this.#settings;
    const token = String(process.env.ONEBOT_TOKEN ?? '').trim() || String(s.token ?? '');
    const driver = new OneBotDriver({
      wsUrl: String(s.wsUrl ?? DEFAULTS.wsUrl),
      token,
      log: host.log?.child?.('driver') ?? host.log,
      apiTimeoutMs: Number(s.apiTimeoutMs) || DEFAULTS.apiTimeoutMs,
      reconnectBaseMs: Number(s.reconnectBaseMs) || DEFAULTS.reconnectBaseMs,
      reconnectMaxMs: Number(s.reconnectMaxMs) || DEFAULTS.reconnectMaxMs,
    });
    this.#driver = driver;

    driver.onEvent((ev) => {
      void this.#handleEvent(ev).catch((err) => {
        host.log?.warn?.('event handling failed', { error: String(err) });
      });
    });
    driver.onReady((idn) => {
      this.#lastError = '';
      this.#status = {
        connected: true,
        selfId: idn?.selfId ?? null,
        nickname: idn?.nickname ?? '',
        implementation: detectImplementation(idn?.version).label,
      };
      this.#syncCatalog(detectImplementation(idn?.version).id);
      this.#pushConnection(true, idn);
    });
    driver.onStatus((status) => {
      if (status.connected) return;
      this.#lastError = status.error || 'disconnected';
      this.#status = { ...this.#status, connected: false };
      this.#pushConnection(false, null, status.error);
    });

    await driver.start();
  }

  async stop() {
    const driver = this.#driver;
    this.#driver = null;
    this.#host = null;
    this.#lastConnection = null;
    if (driver) await driver.stop();
  }

  /**
   * 按配置和实际识别到的实现对换目录。
   * 配置写死实现时以配置为准，识别结果不符只记日志，不擅自换。
   */
  #syncCatalog(detected) {
    const configured = this.#settings.implementation;
    const wanted = configured === 'auto' ? (detected || STANDARD_IMPL) : configured;
    if (configured !== 'auto' && detected && detected !== configured) {
      this.#log?.warn?.('implementation mismatch', { configured, detected });
    }
    if (wanted === this.#catalog.impl) return;
    const next = loadCatalog({ impl: wanted });
    this.#catalog = next;
    this.#log?.info?.('catalog switched', {
      impl: next.impl,
      source: next.source,
      actions: next.total,
    });
  }

  tools() {
    return ONEBOT_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args, ctx) => this.#runTool(decl.name, args ?? {}, ctx),
    }));
  }

  async #runTool(name, args, _ctx) {
    try {
      switch (name) {
        case 'onebot_actions': return this.#toolActions(args);
        case 'onebot_call': return await this.#toolCall(args);
        case 'onebot_events': return this.#toolEvents(args);
        case 'onebot_view_image': return await this.#toolViewImage(args);
        case 'onebot_status': return this.#toolStatus();
        default: return fail(`[onebot] unknown tool: ${name}`);
      }
    } catch (err) {
      this.#log?.error?.('tool failed', { tool: name, error: String(err) });
      return fail(`[onebot] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #toolActions(args) {
    const s = this.#settings;
    const policy = actionPolicy(s);
    const name = typeof args.name === 'string' ? args.name.trim() : '';

    if (name) {
      const spec = this.#catalog.resolve(name);
      if (!spec || policy.disabled(spec, spec.name)) {
        return fail(`[not found] ${name}; use onebot_actions with a query to find an action.`);
      }
      return JSON.stringify({ source: this.#catalog.source, action: spec }, null, 2);
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const category = typeof args.category === 'string' ? args.category.trim() : '';

    if (!query && !category) {
      return JSON.stringify(this.#catalog.summary(), null, 2);
    }

    const result = this.#catalog.list({
      query,
      category,
      policy,
      limit: 50,
    });
    return JSON.stringify({
      source: this.#catalog.source,
      query,
      category,
      total: result.total,
      shown: result.actions.length,
      truncated: result.total > result.actions.length,
      actions: result.actions,
    }, null, 2);
  }

  async #toolCall(args) {
    const s = this.#settings;
    const driver = this.#driver;
    if (!driver) return fail('[not started] OneBot World is not running.');

    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (!action) return fail('[bad input] action is required.');

    const params = args.params === undefined || args.params === null ? {} : args.params;
    if (typeof params !== 'object' || Array.isArray(params)) {
      return fail('[bad input] params must be an object.');
    }

    const spec = this.#catalog.resolve(action);
    const policy = actionPolicy(s);
    const name = spec?.name ?? action;
    const readOnly = spec?.readOnly === true;

    // 被禁用的动作对模型等同于不存在：与未知动作共用同一条回执，不暴露"禁用"这回事。
    if (!spec || policy.disabled(spec, spec.name)) {
      return fail(`[unknown action] ${action}; use onebot_actions to find a valid action.`);
    }
    if (s.actions.readOnly === true && !readOnly) {
      return fail(`[read-only] ${name} is a write action; this deployment is read-only.`);
    }

    if (!readOnly) {
      if (s.actions.writePolicy === 'deny') {
        return fail('[denied] this deployment does not allow writes.');
      }
      if (s.actions.writePolicy === 'confirm' && args.confirm !== true) {
        return `[confirm required] ${name} is a write action. Review the params, then call again with confirm=true.\nparams: ${compactJson(params, 2000)}`;
      }
    }

    const timeout = Number(args.timeout_ms);
    const result = await driver.callSafe(
      name,
      params,
      Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(timeout, 1000), 120000) : undefined,
    );

    const payload = {
      action: name,
      ok: result.ok,
      ...(result.ok
        ? { data: result.data }
        : {
            error: result.error,
            ...(result.retcode !== undefined ? { retcode: result.retcode } : {}),
          }),
      ...(ACTION_NOTES[name] ? { note: ACTION_NOTES[name] } : {}),
    };

    if (result.ok) {
      this.#log?.info?.('action ok', { action: name });
    } else {
      this.#log?.warn?.('action failed', {
        action: name,
        retcode: result.retcode ?? null,
        error: result.error,
      });
    }

    return capText(JSON.stringify(payload, null, 2), MAX_ACTION_RESULT_CHARS);
  }

  #toolEvents(args) {
    const host = this.#host;
    if (!host) return fail('[not started] OneBot World is not running.');

    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    const since = parseIso(args.since);
    const until = parseIso(args.until);
    if (since === false) return fail(`[bad input] since "${args.since}" is not an ISO 8601 time.`);
    if (until === false) return fail(`[bad input] until "${args.until}" is not an ISO 8601 time.`);

    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
    const kindMatcher = kind ? matcher([kind]) : null;
    const query = { source: ID, limit: 2000 };
    if (since) query.fromTs = since;
    if (until) query.toTs = until;

    const events = host.store.range(query)
      .filter((event) => event.type === EVENT_MESSAGE || event.type === EVENT_RAW || event.type === EVENT_CONNECTION)
      .filter((event) => !kindMatcher || kindMatcher.match(event.meta?.kind))
      .slice(-limit)
      .map((event) => ({
        ts: event.ts,
        type: event.type,
        kind: event.meta?.kind ?? '',
        text: event.text,
        ...(args.raw === false ? {} : { raw: event.meta?.raw }),
      }));

    return JSON.stringify({ count: events.length, events }, null, 2);
  }

  async #toolViewImage(args) {
    const driver = this.#driver;
    if (!driver) return fail('[not started] OneBot World is not running.');
    const s = this.#settings;

    const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
    const file = typeof args.file === 'string' ? args.file.trim() : '';
    const fileId = typeof args.file_id === 'string' ? args.file_id.trim() : '';
    let url = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
    if (!url && /^https?:\/\//i.test(file)) url = file;

    if (!url) {
      if (!file && !fileId) {
        return fail('[bad input] provide url, file or file_id.');
      }
      const info = await driver.callSafe('get_image', {
        ...(file ? { file } : {}),
        ...(fileId ? { file_id: fileId } : {}),
      });
      if (!info.ok) return fail(`[image lookup failed] ${info.error}`);
      const data = info.data && typeof info.data === 'object' ? info.data : {};
      const candidate = [data.url, data.file]
        .find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
      if (!candidate) {
        return fail(`[image lookup failed] get_image returned no http(s) URL: ${compactJson(data, 1000)}`);
      }
      url = candidate;
    }

    try {
      const timeoutMs = Number(args.timeout_ms) || Number(s.images.timeoutMs) || DEFAULTS.images.timeoutMs;
      const maxBytes = Number(s.images.maxImageBytes) || DEFAULTS.images.maxImageBytes;
      const image = await downloadImage(url, { timeoutMs, maxBytes });
      const ext = extensionForMime(image.mime);
      return {
        text: `[image ${url}]`,
        blobs: [{
          bytes: image.bytes,
          mime: image.mime,
          name: `onebot-image.${ext}`,
          fallbackText: `[image ${url}]`,
        }],
      };
    } catch (err) {
      return fail(`[image download failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #toolStatus() {
    const s = this.#settings;
    const idn = this.#driver?.identity;
    return JSON.stringify({
      connected: this.#driver?.connected === true,
      wsUrl: String(s.wsUrl ?? ''),
      selfId: idn?.selfId ?? this.#status.selfId ?? null,
      nickname: idn?.nickname ?? this.#status.nickname ?? '',
      version: idn?.version ?? null,
      catalog: {
        source: this.#catalog.source,
        version: this.#catalog.version,
      },
      actions: {
        readOnly: s.actions.readOnly === true,
        writePolicy: s.actions.writePolicy,
      },
      events: {
        deliver: patterns(s.events.deliver),
        mute: patterns(s.events.mute),
        drop: patterns(s.events.drop),
      },
      lastError: this.#lastError,
      startedAt: this.#startedAt,
    }, null, 2);
  }

  async #handleEvent(ev) {
    const host = this.#host;
    if (!host) return;

    const s = this.#settings;
    const policy = eventPolicy(s);
    const kind = eventKind(ev);
    if (policy.drop(kind)) return;

    const isMessage = ev?.post_type === 'message';
    const selfId = this.#driver?.identity?.selfId;
    const hasSelf = Number.isFinite(Number(selfId)) && Number(selfId) > 0;
    const isSelf = isMessage && hasSelf && Number(ev?.user_id) === Number(selfId);
    const maxChars = Number(s.maxEventChars) || DEFAULTS.maxEventChars;
    const text = capText(
      isMessage
        ? renderMessage(ev, this.#timezone)
        : `[${kind}] ${compactJson(ev, maxChars)}`,
      maxChars,
    );

    const meta = { kind, raw: ev, ...(isSelf ? { self: true } : {}) };
    if (isMessage) {
      const conv = ev.message_type === 'group'
        ? { kind: 'group', id: Number(ev.group_id) }
        : ev.message_type === 'private'
          ? { kind: 'private', id: Number(ev.user_id) }
          : null;
      if (conv && Number.isFinite(conv.id)) meta.conv = conv;
    }

    const blobs = isMessage ? await this.#downloadMessageImages(ev, host, s) : [];
    host.pushEvent({
      type: isMessage ? EVENT_MESSAGE : EVENT_RAW,
      ts: isMessage ? eventTs(ev) : nowIso(),
      source: ID,
      text,
      senderKey: isMessage
        ? String(ev?.user_id ?? '')
        : (ev?.user_id !== undefined ? String(ev.user_id) : undefined),
      meta,
      ...(blobs.length ? { blobs } : {}),
    }, {
      deliver: isSelf ? false : policy.deliver(kind),
      trigger: 'debounce',
    }).catch((err) => host.log?.warn?.('event push failed', { kind, error: String(err) }));
  }

  /** 把消息里的图片下载成 blobs；模型不接受图片时跳过，省流量也省内存。 */
  async #downloadMessageImages(ev, host, s) {
    if (s.images.download === false) return [];
    const acceptsImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
      .some((mime) => host.modelFacts?.accepts?.(mime) === true);
    if (!acceptsImage) return [];

    const maxPerMessage = Math.max(
      1,
      Math.min(16, Number(s.images.maxPerMessage) || DEFAULTS.images.maxPerMessage),
    );
    const sources = imageSourcesFromMessage(ev).slice(0, maxPerMessage);
    if (!sources.length) return [];

    const timeoutMs = Number(s.images.timeoutMs) || DEFAULTS.images.timeoutMs;
    const maxBytes = Number(s.images.maxImageBytes) || DEFAULTS.images.maxImageBytes;
    const settled = await Promise.allSettled(
      sources.map((source) => downloadImage(source.url, { timeoutMs, maxBytes })),
    );

    const blobs = [];
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        host.log?.warn?.('image download failed', {
          messageId: ev?.message_id,
          url: sources[index].url,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return;
      }
      const image = result.value;
      blobs.push({
        bytes: image.bytes,
        mime: image.mime,
        name: `onebot-${ev?.message_id ?? 'msg'}-${index + 1}.${extensionForMime(image.mime)}`,
        fallbackText: `[图片 ${sources[index].url}]`,
      });
    });
    return blobs;
  }

  #pushConnection(connected, idn, error = '') {
    const host = this.#host;
    if (!host || this.#lastConnection === connected) return;
    this.#lastConnection = connected;
    const impl = idn ? detectImplementation(idn.version).label : this.#status.implementation;
    this.#status = {
      connected,
      selfId: idn?.selfId ?? this.#status.selfId ?? null,
      nickname: idn?.nickname ?? this.#status.nickname ?? '',
      implementation: impl,
    };

    const who = idn && Number.isFinite(Number(idn.selfId))
      ? `${idn.nickname || ''}(${idn.selfId})`
      : (idn?.nickname || '');
    const name = impl || 'OneBot';
    const text = connected
      ? `[系统] ${name} 已连接${who ? `：${who}` : ''}`
      : `[系统] ${name} 连接断开${error ? `：${error}` : ''}`;

    host.pushEvent({
      type: EVENT_CONNECTION,
      ts: nowIso(),
      source: ID,
      text,
      meta: {
        kind: connected ? 'connection/ready' : 'connection/closed',
        connected,
        selfId: idn?.selfId ?? null,
        nickname: idn?.nickname ?? '',
        error,
      },
    }, { trigger: 'debounce' }).catch((err) => {
      host.log?.warn?.('connection event push failed', { error: String(err) });
    });
  }
}

/** auto 在加载目录前必须先解析成具体实现，否则没有文件可读。 */
function implOf(cfg) {
  return cfg.implementation === 'auto' ? STANDARD_IMPL : cfg.implementation;
}

/** 各实现能提供目录的运行期地址；没有的返回空串，由使用者填。 */
function catalogUrlFor(impl) {
  return impl === 'napcat' ? 'http://127.0.0.1:6099/api/Debug/schemas' : '';
}

function nowIso(date = new Date()) {
  return date.toISOString();
}

function eventTs(ev) {
  const seconds = Number(ev?.time);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : nowIso();
}

function parseIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? false : new Date(ms).toISOString();
}
