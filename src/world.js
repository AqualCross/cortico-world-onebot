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
import { actionPolicy, eventPolicy, matcher, receivePolicy } from './policy.js';
import { conversationOf } from './conversations.js';
import { capText, compactJson, eventKind, renderMessage } from './render.js';
import { downloadImage, extensionForMime, imageSourcesFromMessage } from './images.js';
import { detectImplementation } from './implementations.js';
import { OneBotDriver } from './driver.js';
import {
  checkActionParams,
  checkActionUrls,
  normalizeReadPaths,
  readPathStatus,
  readPathsOf,
} from './file-policy.js';

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
      'Call any OneBot action. Read-only actions run immediately; write actions require confirm=true. '
      + 'Local file paths in params and message segments must lie under the deployment\'s allowed read paths; '
      + 'URLs must resolve to public addresses.',
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
    name: 'onebot_receive',
    tags: ['act'],
    description:
      'Choose which QQ conversations deliver events to you. Events from unselected conversations are dropped '
      + 'before they are stored or shown, so they never wake you. Their history is still available through '
      + 'get_group_msg_history / get_friend_msg_history via onebot_call. Actions: list (default), set, add, remove. '
      + 'Keys are group:<id>, private:<id>, group:*, private:*, or *. Writes follow the deployment write policy; '
      + 'with the default confirm policy, pass confirm=true.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'add', 'remove'],
          description: 'list reads the current selection; set replaces it; add appends; remove drops keys or patterns.',
        },
        conversations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys to write, e.g. ["group:123","private:456"] or ["*"]. Required for set/add/remove.',
        },
        query: { type: 'string', description: 'list only: case-insensitive filter on name, id or key.' },
        confirm: { type: 'boolean', description: 'Set true to execute set/add/remove under the confirm write policy.' },
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
      'OneBot connection, account, catalog, received conversations, and current write/event/file policy.',
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
  #persist;
  #convCache = { at: 0, items: [] };
  #status = { connected: false, selfId: null, nickname: '', implementation: '' };

  constructor(opts = {}) {
    this.id = ID;
    this.#cfg = opts.cfg ?? {};
    this.#timezone = opts.timezone ?? '';
    this.#persist = typeof opts.persist === 'function' ? opts.persist : null;
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
    const receive = receivePolicy(s);
    const receiveWildcard = receive.patterns.some((pattern) => pattern !== '*' && pattern.includes('*'));
    const readPaths = readPathsOf(s);
    return {
      label: t.label,
      lamps: [{ label: t.lamp, state, hint }],
      badges: [
        {
          label: t.connection,
          value: connected ? t.connectedAs(impl, who) : t.disconnected,
          tone: connected ? 'on' : 'off',
        },
        {
          label: t.receive,
          value: receive.all
            ? t.receiveAll
            : (receiveWildcard ? t.receiveCustom : t.receiveCount(receive.patterns.length)),
          tone: receive.patterns.length ? 'on' : 'off',
        },
        { label: t.actions, value: `${counts.enabled}/${counts.total}` },
        {
          label: t.readPaths,
          value: readPaths.length ? t.readPathsCount(readPaths.length) : t.readPathsBlocked,
          tone: readPaths.length ? 'on' : 'off',
        },
      ],
      config: [configGroup(language)],
      panels: [
        {
          id: 'actions',
          title: t.catalogPanelTitle,
          description: t.catalogPanelDesc,
        },
        {
          id: 'receive',
          title: t.receivePanelTitle,
          description: t.receivePanelDesc,
        },
        {
          id: 'files',
          title: t.readPathsPanelTitle,
          description: t.readPathsPanelDesc,
        },
      ],
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

  /** 控制台面板的数据面：动作目录读状态/更新；接收的会话读状态/保存。 */
  async #invokePanel(panel, method, args) {
    if (panel === 'actions') {
      if (method === 'state') return this.#catalogState();
      if (method === 'update') return await this.#updateCatalog(args[0], args[1]);
      if (method === 'save') return this.#saveActionSelection(args[0]);
      throw new Error(`unknown method: ${panel}.${method}`);
    }
    if (panel === 'receive') {
      if (method === 'state') return await this.#receiveState(args[0] === true);
      if (method === 'save') return await this.#saveReceive(args[0]);
      throw new Error(`unknown method: ${panel}.${method}`);
    }
    if (panel === 'files') {
      if (method === 'state') return this.#filesState();
      if (method === 'save') return this.#saveReadPaths(args[0]);
      throw new Error(`unknown method: ${panel}.${method}`);
    }
    throw new Error(`unknown panel: ${panel}`);
  }

  #catalogState() {
    const settings = this.#settings;
    const policy = actionPolicy(settings);
    const counts = this.#catalog.counts(policy);
    const rules = patterns(settings.actions.disabled);
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
      items: this.#catalog.actions.map((action) => ({
        name: action.name,
        category: action.category ?? '',
        summary: action.summary ?? '',
        readOnly: action.readOnly === true,
        enabled: !policy.disabled(action, action.name),
      })),
      patterned: rules.some((rule) => rule.includes('*') || rule.startsWith('category:')),
    };
  }

  /** 面板保存的是勾选后的动作名；落盘写成显式的禁用名单。 */
  #saveActionSelection(value) {
    if (!Array.isArray(value)) throw new Error('actions must be an array of action names');
    const names = new Set();
    for (const entry of value) {
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (!name) throw new Error(`invalid action name: ${String(entry)}`);
      const spec = this.#catalog.resolve(name);
      if (!spec) throw new Error(`unknown action: ${name}`);
      names.add(spec.name);
    }

    const disabled = this.#catalog.actions
      .filter((action) => !names.has(action.name))
      .map((action) => action.name);
    const stored = disabled.join(', ');
    this.#writeActionsDisabled(stored);
    return { ...this.#catalogState(), saved: stored };
  }

  #writeActionsDisabled(value) {
    this.#persist?.({ actions: { disabled: value } });
    if (!this.#cfg.actions || typeof this.#cfg.actions !== 'object') this.#cfg.actions = {};
    this.#cfg.actions.disabled = value;
    this.#log?.info?.('actions updated', { disabled: patterns(value).length });
    return value;
  }

  #filesState() {
    const paths = readPathsOf(this.#settings);
    return {
      paths,
      entries: paths.map((path) => readPathStatus(path)),
      stored: String(this.#settings.files?.readPaths ?? ''),
    };
  }

  #saveReadPaths(value) {
    const paths = normalizeReadPaths(value);
    const stored = paths.join('\n');
    this.#persist?.({ files: { readPaths: stored } });
    if (!this.#cfg.files || typeof this.#cfg.files !== 'object') this.#cfg.files = {};
    this.#cfg.files.readPaths = stored;
    this.#log?.info?.('read paths updated', { count: paths.length });
    return { ...this.#filesState(), saved: stored };
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
    this.#convCache = { at: 0, items: [] };

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
      this.#convCache = { at: 0, items: [] };
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
      this.#convCache = { at: 0, items: [] };
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
    this.#convCache = { at: 0, items: [] };
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
        case 'onebot_receive': return await this.#toolReceive(args);
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

    const blocked = checkActionParams(spec, params, s);
    if (blocked) {
      this.#log?.warn?.('local file blocked', {
        action: name,
        path: blocked.path,
        via: blocked.via,
        reason: blocked.reason,
      });
      return fail(
        `[blocked] ${name} would read ${blocked.path} (${blocked.via}), which ${blocked.reason}. `
        + 'Add its directory to the OneBot read-path allowlist (worlds.onebot.files.readPaths) to allow it.',
      );
    }

    const blockedUrl = await checkActionUrls(spec, params, s);
    if (blockedUrl) {
      this.#log?.warn?.('private URL blocked', {
        action: name,
        url: blockedUrl.url,
        via: blockedUrl.via,
        reason: blockedUrl.reason,
      });
      return fail(
        `[blocked] ${name} would fetch ${blockedUrl.url} (${blockedUrl.via}): ${blockedUrl.reason}. `
        + 'Only public addresses are allowed; enable worlds.onebot.images.allowPrivateHosts '
        + 'if the service is on this machine or the LAN.',
      );
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

  async #toolReceive(args) {
    const s = this.#settings;
    const action = args.action === undefined ? 'list' : String(args.action).trim().toLowerCase();
    if (!['list', 'set', 'add', 'remove'].includes(action)) {
      return fail(`[bad input] unknown action: ${action}; use list, set, add or remove.`);
    }

    const policy = receivePolicy(s);
    if (action === 'list') {
      const configured = configuredItems(policy);
      let available = [];
      let error = '';
      if (this.#driver?.connected) {
        try {
          available = await this.#availableConversations(false);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      } else {
        error = 'OneBot is not connected; only the current receive list is shown.';
      }
      const items = mergeItems(available, configured, policy);
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const matched = query
        ? items.filter((item) => `${item.key} ${item.name} ${item.id}`.toLowerCase().includes(query))
        : items;
      const cap = 200;
      return JSON.stringify({
        connected: this.#driver?.connected === true,
        receive: policy.patterns,
        all: policy.all,
        total: matched.length,
        truncated: matched.length > cap,
        conversations: matched.slice(0, cap),
        ...(error ? { error } : {}),
      }, null, 2);
    }

    if (s.actions.readOnly === true) {
      return fail('[read-only] this deployment does not allow writes.');
    }
    if (s.actions.writePolicy === 'deny') {
      return fail('[denied] this deployment does not allow writes.');
    }
    if (!Array.isArray(args.conversations) && typeof args.conversations !== 'string') {
      return fail('[bad input] conversations is required for set, add and remove.');
    }
    let keys;
    try {
      keys = normalizeReceiveKeys(args.conversations);
    } catch (err) {
      return fail(`[bad input] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (action !== 'set' && !keys.length) {
      return fail('[bad input] conversations is required for add and remove.');
    }
    if (s.actions.writePolicy === 'confirm' && args.confirm !== true) {
      return `[confirm required] onebot_receive ${action} changes which conversations deliver events.\n`
        + `conversations: ${keys.length ? keys.join(', ') : '(none)'}\n`
        + 'Call again with confirm=true to apply it.';
    }

    try {
      let next;
      if (action === 'set') next = keys;
      else if (action === 'add') next = addReceive(policy.patterns, keys);
      else next = await this.#removeReceive(policy.patterns, keys);
      const stored = next.includes('*') ? '*' : next.join(', ');
      this.#writeReceive(stored);
      return JSON.stringify({
        ok: true,
        action,
        receive: patterns(stored),
        all: stored === '*',
        ...(next.length ? {} : { note: 'No conversations are received now.' }),
      }, null, 2);
    } catch (err) {
      return fail(`[onebot_receive failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #receiveState(refresh = false) {
    const policy = receivePolicy(this.#settings);
    const configured = configuredItems(policy).map((item) => ({ ...item, received: true }));
    let items = configured;
    let error = '';
    if (this.#driver?.connected) {
      try {
        items = mergeItems(await this.#availableConversations(refresh === true), configured, policy);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      connected: this.#driver?.connected === true,
      receive: policy.patterns,
      all: policy.all,
      items,
      ...(error ? { error } : {}),
    };
  }

  async #saveReceive(value) {
    if (!Array.isArray(value) && typeof value !== 'string') {
      throw new Error('conversations must be an array of keys');
    }
    const keys = normalizeReceiveKeys(value);
    const stored = keys.includes('*') ? '*' : keys.join(', ');
    this.#writeReceive(stored);
    return { ...(await this.#receiveState(false)), saved: stored };
  }

  #writeReceive(value) {
    this.#persist?.({ conversations: { receive: value } });
    if (!this.#cfg.conversations || typeof this.#cfg.conversations !== 'object') {
      this.#cfg.conversations = {};
    }
    this.#cfg.conversations.receive = value;
    this.#log?.info?.('receive updated', { receive: value });
    return value;
  }

  async #availableConversations(refresh) {
    const driver = this.#driver;
    if (!driver?.connected) throw new Error('OneBot is not connected.');
    if (!refresh && this.#convCache.at && Date.now() - this.#convCache.at < 60_000) {
      return this.#convCache.items;
    }
    const [groups, friends] = await Promise.all([
      driver.callSafe('get_group_list', {}),
      driver.callSafe('get_friend_list', {}),
    ]);
    if (!groups.ok) throw new Error(`get_group_list failed: ${groups.error}`);
    if (!friends.ok) throw new Error(`get_friend_list failed: ${friends.error}`);

    const items = [];
    const seen = new Set();
    const add = (kind, rawId, name) => {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const key = `${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ key, kind, id, name: String(name || id) });
    };
    for (const group of listOf(groups.data, 'groups')) {
      add('group', group?.group_id, group?.group_name);
    }
    for (const friend of listOf(friends.data, 'friends')) {
      add('private', friend?.user_id, friend?.remark || friend?.nickname);
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.id - b.id);
    this.#convCache = { at: Date.now(), items };
    return items;
  }

  async #removeReceive(current, removals) {
    const needsList = current.includes('*')
      || current.some((pattern) => pattern !== '*' && pattern.includes('*'));
    let base;
    if (needsList) {
      const available = await this.#availableConversations(true);
      const currentMatch = matcher(current);
      base = available.filter((item) => currentMatch.match(item.key)).map((item) => item.key);
      for (const pattern of current) {
        if (!pattern.includes('*') && !base.includes(pattern)) base.push(pattern);
      }
    } else {
      base = [...current];
    }
    const remove = matcher(removals);
    return base.filter((key) => !remove.match(key));
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
      const image = await downloadImage(url, {
        timeoutMs,
        maxBytes,
        allowPrivate: s.images.allowPrivateHosts === true,
      });
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
      files: {
        readPaths: readPathsOf(s),
      },
      events: {
        deliver: patterns(s.events.deliver),
        mute: patterns(s.events.mute),
        drop: patterns(s.events.drop),
      },
      conversations: {
        receive: patterns(s.conversations.receive),
        all: receivePolicy(s).all,
      },
      lastError: this.#lastError,
      startedAt: this.#startedAt,
    }, null, 2);
  }

  async #handleEvent(ev) {
    const host = this.#host;
    if (!host) return;

    const s = this.#settings;
    const conv = conversationOf(ev);
    if (conv && !receivePolicy(s).receive(conv.key)) return;

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
    if (conv) meta.conv = { kind: conv.kind, id: conv.id };

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
    const allowPrivate = s.images.allowPrivateHosts === true;
    const settled = await Promise.allSettled(
      sources.map((source) => downloadImage(source.url, { timeoutMs, maxBytes, allowPrivate })),
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

const RECEIVE_KEY = /^(?:group|private):(?:\*|\d+)$/;

/** 接收名单只接受会话键或 *；返回去重后的键，含 * 时只剩 *。 */
function normalizeReceiveKeys(value) {
  const keys = [];
  for (const raw of patterns(value)) {
    const key = raw.toLowerCase();
    if (key === '*') return ['*'];
    if (!RECEIVE_KEY.test(key)) {
      throw new Error(`invalid conversation key: ${raw}; use group:<id>, private:<id>, group:*, private:*, or *`);
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** 名单里能落到具体会话的键；通配符不展开。 */
function configuredItems(policy) {
  const items = [];
  const seen = new Set();
  for (const pattern of policy.patterns) {
    const match = /^(group|private):(\d+)$/.exec(pattern);
    if (!match) continue;
    const id = Number(match[2]);
    const key = `${match[1]}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: match[1], id, name: '' });
  }
  return items;
}

function mergeItems(available, configured, policy) {
  const seen = new Set(available.map((item) => item.key));
  const items = available.map((item) => ({ ...item, received: policy.receive(item.key) }));
  for (const item of configured) {
    if (!seen.has(item.key)) items.push({ ...item, received: true });
  }
  return items;
}

function addReceive(current, keys) {
  if (current.includes('*') || keys.includes('*')) return ['*'];
  return [...new Set([...current, ...keys])];
}

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
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
