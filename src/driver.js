/**
 * 最小 OneBot v11 正向 WebSocket 驱动。
 *
 * 一条双工连接同时做两件事：接收所有事件、按 echo 关联 action 响应。
 * 重连、超时、失败信封都在这里，World 只看到 callSafe() 和 onEvent()。
 */
import WebSocket from 'ws';

const DEFAULT_API_TIMEOUT_MS = 10000;

class OneBotApiError extends Error {
  constructor(message, retcode) {
    super(message);
    this.name = 'OneBotApiError';
    this.retcode = retcode;
  }
}

const msgOf = (err) => (err instanceof Error ? err.message : String(err));

export class OneBotDriver {
  #opts;
  #log;
  #ws;
  #stopped = true;
  #echoSeq = 0;
  #pending = new Map();
  #backoffMs;
  #reconnectTimer;
  #eventCbs = [];
  #readyCbs = [];
  #statusCbs = [];

  connected = false;
  identity = null;

  constructor(opts) {
    this.#opts = opts;
    this.#log = opts.log;
    this.#backoffMs = Number(opts.reconnectBaseMs) || 1000;
  }

  onEvent(cb) {
    this.#eventCbs.push(cb);
  }

  onReady(cb) {
    this.#readyCbs.push(cb);
  }

  onStatus(cb) {
    this.#statusCbs.push(cb);
  }

  /** 首次连接尝试结束后 resolve；失败时后台继续退避重连。 */
  start() {
    if (this.connected) return Promise.resolve();
    this.#stopped = false;
    this.#backoffMs = Number(this.#opts.reconnectBaseMs) || 1000;
    return new Promise((resolve) => {
      this.#connect(resolve);
    });
  }

  async stop() {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#rejectAllPending(new Error('driver stopped'));
    const ws = this.#ws;
    this.#ws = undefined;
    this.connected = false;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  /** 测试/联调辅助：等连接和身份都就绪。 */
  waitReady(timeoutMs = 10000) {
    if (this.connected && this.identity) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`OneBot ready timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      const cb = () => {
        clearTimeout(timer);
        remove();
        resolve();
      };
      const remove = () => {
        const index = this.#readyCbs.indexOf(cb);
        if (index >= 0) this.#readyCbs.splice(index, 1);
      };
      this.#readyCbs.push(cb);
    });
  }

  call(action, params = {}, timeoutMs) {
    const timeout = Number(timeoutMs) || Number(this.#opts.apiTimeoutMs) || DEFAULT_API_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`${action}: WS not connected`));
        return;
      }
      const echo = `sl-${++this.#echoSeq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`${action}: timeout (${timeout}ms)`));
      }, timeout);
      this.#pending.set(echo, { action, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 不抛错：协议端返回 failed / timeout / disconnected 都变成信封。 */
  async callSafe(action, params = {}, timeoutMs) {
    try {
      return { ok: true, data: await this.call(action, params, timeoutMs) };
    } catch (err) {
      const message = msgOf(err);
      return {
        ok: false,
        error: message,
        ...(typeof err?.retcode === 'number' ? { retcode: err.retcode } : {}),
      };
    }
  }

  #connect(onSettled) {
    if (this.#stopped) {
      onSettled?.();
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      onSettled?.();
    };

    const opts = this.#opts;
    let ws;
    try {
      ws = new WebSocket(opts.wsUrl, {
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
      });
    } catch (err) {
      this.#log?.warn?.('WS create failed', { error: msgOf(err), wsUrl: opts.wsUrl });
      settle();
      if (!this.#stopped) this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.on('open', () => {
      if (this.#stopped || this.#ws !== ws) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        settle();
        return;
      }

      this.connected = true;
      this.#backoffMs = Number(opts.reconnectBaseMs) || 1000;
      this.#log?.info?.('WS connected', { wsUrl: opts.wsUrl });
      this.#emitStatus({ connected: true });

      void (async () => {
        try {
          this.identity = await this.#initIdentity();
        } catch (err) {
          this.#log?.warn?.('identity init failed', { error: msgOf(err) });
        }
        if (this.#stopped || this.#ws !== ws) {
          settle();
          return;
        }
        for (const cb of [...this.#readyCbs]) {
          try {
            cb(this.identity);
          } catch (err) {
            this.#log?.error?.('ready callback failed', { error: msgOf(err) });
          }
        }
        settle();
      })();
    });

    ws.on('message', (data) => {
      if (!this.#stopped && this.#ws === ws) this.#handleMessage(String(data));
    });

    ws.on('error', (err) => {
      this.#log?.warn?.('WS error', { error: msgOf(err) });
    });

    ws.on('close', () => {
      const current = this.#ws === ws;
      if (current) {
        this.#ws = undefined;
        this.connected = false;
        this.#rejectAllPending(new Error('WS disconnected'));
        if (!this.#stopped) this.#emitStatus({ connected: false, error: 'WS disconnected' });
      }
      settle();
      if (current && !this.#stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#stopped) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(
      this.#backoffMs * 2,
      Number(this.#opts.reconnectMaxMs) || 30000,
    );
    this.#log?.info?.(`reconnect in ${delay}ms`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (!this.#stopped) this.#connect();
    }, delay);
  }

  async #initIdentity() {
    const login = await this.call('get_login_info');
    let version = null;
    try {
      version = await this.call('get_version_info');
    } catch {
      /* 老实现可能没有这个 action */
    }
    return {
      selfId: Number(login?.user_id),
      nickname: String(login?.nickname ?? ''),
      version,
    };
  }

  #handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.#log?.warn?.('non-JSON WS message ignored');
      return;
    }

    if (msg.echo !== undefined && msg.echo !== null) {
      const key = String(msg.echo);
      const call = this.#pending.get(key);
      if (!call) return;
      this.#pending.delete(key);
      clearTimeout(call.timer);
      const retcode = Number(msg.retcode ?? -1);
      const status = String(msg.status ?? '');
      if (retcode === 0 || status === 'ok' || status === 'async') {
        call.resolve(msg.data);
      } else {
        call.reject(new OneBotApiError(
          `${call.action}: retcode=${retcode}${msg.message ? ` ${String(msg.message)}` : ''}`,
          retcode,
        ));
      }
      return;
    }

    if (msg.post_type !== undefined) {
      for (const cb of [...this.#eventCbs]) {
        try {
          cb(msg);
        } catch (err) {
          this.#log?.error?.('event callback failed', { error: msgOf(err) });
        }
      }
    }
  }

  #emitStatus(status) {
    for (const cb of [...this.#statusCbs]) {
      try {
        cb(status);
      } catch (err) {
        this.#log?.error?.('status callback failed', { error: msgOf(err) });
      }
    }
  }

  #rejectAllPending(err) {
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`${call.action}: ${err.message}`));
    }
    this.#pending.clear();
  }
}
