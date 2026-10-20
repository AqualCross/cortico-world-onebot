/**
 * 消息可读化 + 所有其他 OneBot 事件的兜底正文。
 *
 * 只有 message 事件值得精写；notice/request/meta_event 一律压成一行 JSON。
 * 未识别的 segment 也有兜底，所以新增段类型不会让消息消失。
 */

export function eventKind(ev) {
  const type = ev?.message_type ?? ev?.notice_type ?? ev?.request_type ?? ev?.meta_event_type;
  const parts = [ev?.post_type, type];
  // 消息事件的 sub_type（normal/friend/...）不放进 kind，保持 message/group、message/private 稳定。
  if (ev?.post_type !== 'message' && ev?.sub_type) parts.push(ev.sub_type);
  return parts.filter((part) => part !== undefined && part !== null && part !== '').join('/') || 'unknown';
}

function formatTime(ev, timezone) {
  const seconds = Number(ev?.time);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      ...(timezone ? { timeZone: timezone } : {}),
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 19);
  }
}

export function renderSegment(seg) {
  if (typeof seg === 'string') return seg;
  const type = seg?.type;
  const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
  switch (type) {
    case 'text':
      return String(data.text ?? '');
    case 'at': {
      const who = data.qq === 'all' ? '全体成员' : (data.name || data.qq || '');
      return `@${who}`;
    }
    case 'reply':
      return `[回复 #${data.id ?? ''}]`;
    case 'image': {
      const label = data.summary || data.file || data.url || '';
      return label ? `[图片 ${label}]` : '[图片]';
    }
    case 'face':
      return `[表情 ${data.id ?? ''}]`;
    case 'record': {
      const label = data.file || data.url || '';
      return label ? `[语音 ${label}]` : '[语音]';
    }
    case 'video':
      return '[视频]';
    case 'file': {
      const label = data.name || data.file || '';
      return label ? `[文件 ${label}]` : '[文件]';
    }
    case 'forward':
      return data.id ? `[转发 #${data.id}]` : '[转发]';
    case 'json':
    case 'xml':
      return '[卡片]';
    case 'poke':
      return '[戳一戳]';
    case 'mface': {
      const label = data.summary || data.emoji_id || '';
      return label ? `[表情 ${label}]` : '[表情]';
    }
    case 'dice':
      return data.result ? `[骰子 ${data.result}]` : '[骰子]';
    case 'rps':
      return data.result ? `[猜拳 ${data.result}]` : '[猜拳]';
    case 'markdown':
      return '[Markdown]';
    case 'light_app':
      return '[应用卡片]';
    case 'node':
      return '[转发节点]';
    default:
      return type ? `[${type}]` : '';
  }
}

export function renderMessage(ev, timezone) {
  const label = ev?.message_type === 'group'
    ? `群${ev.group_id ?? '?'}`
    : ev?.message_type === 'private'
      ? `私聊${ev.user_id ?? '?'}`
      : (ev?.message_type ?? '消息');
  const sender = ev?.sender?.card || ev?.sender?.nickname || String(ev?.user_id ?? '?');
  const raw = ev?.message;
  const body = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map(renderSegment).join('')
      : '';
  const id = ev?.message_id !== undefined ? ` #${ev.message_id}` : '';
  return `[${label} ${formatTime(ev, timezone)}] ${sender}(${ev?.user_id ?? '?'}): ${body || '[空消息]'}${id}`;
}

export function capText(value, maxChars = 4000) {
  const text = String(value ?? '');
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export function compactJson(value, maxChars = 4000) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return capText(text, maxChars);
}
