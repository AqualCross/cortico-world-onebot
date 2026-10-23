/**
 * 用配置做减法：默认全部允许，命中 disabled / mute / drop 才拒绝。
 * 匹配串支持 *，action 还支持 category:<分类>。
 */
import { patterns } from './config.js';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 a*b 编译成 ^a.*b$；空串匹配空串。 */
export function compile(pattern) {
  const source = String(pattern)
    .split('*')
    .map(escapeRegExp)
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

export function matcher(list) {
  const values = patterns(list);
  const rules = values.map((raw) => ({ raw, re: compile(raw) }));
  const match = (value) => {
    if (value === undefined || value === null) return false;
    const text = String(value);
    return rules.some(({ re }) => re.test(text));
  };
  return {
    patterns: values,
    match,
    any(valuesToTest) {
      return valuesToTest.some((value) => match(value));
    },
  };
}

export function actionPolicy(cfg) {
  const disabled = matcher(cfg.actions.disabled);
  const disabledCategories = matcher(cfg.actions.disabledCategories);
  return {
    disabled(spec, name) {
      const values = [name, ...(spec?.aliases ?? [])];
      if (spec?.category) values.push(`category:${spec.category}`);
      if (disabled.any(values)) return true;
      return Boolean(spec?.category && disabledCategories.match(spec.category));
    },
  };
}

export function eventPolicy(cfg) {
  const deliver = matcher(cfg.events.deliver);
  const mute = matcher(cfg.events.mute);
  const drop = matcher(cfg.events.drop);
  return {
    drop(kind) {
      return drop.match(kind);
    },
    mute(kind) {
      return mute.match(kind);
    },
    deliver(kind) {
      return deliver.match(kind) && !mute.match(kind);
    },
  };
}

/**
 * 「接收哪些会话」白名单：空名单不接收任何会话事件，* 接收全部。
 * 没有会话的事件（meta_event 等）不受它管。
 */
export function receivePolicy(cfg) {
  const receive = matcher(cfg?.conversations?.receive);
  return {
    patterns: receive.patterns,
    all: receive.patterns.includes('*'),
    receive(key) {
      if (key === undefined || key === null) return true;
      return receive.match(key);
    },
  };
}
