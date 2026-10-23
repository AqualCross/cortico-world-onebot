/**
 * 会话键：群聊是 group:<群号>，私聊是 private:<QQ号>。
 * 消息、通知、请求共用同一把键；meta_event 没有会话。
 */

function toId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 返回 { kind, id, key }，没有会话时返回 null。 */
export function conversationOf(event) {
  if (!event || typeof event !== 'object') return null;

  const groupId = toId(event.group_id);
  if (groupId !== null) return { kind: 'group', id: groupId, key: `group:${groupId}` };

  // message_sent 的 user_id 是 bot 自己；私聊目标在 target_id。
  const userId = event.post_type === 'message_sent'
    ? toId(event.target_id)
    : toId(event.user_id);
  if (userId !== null) return { kind: 'private', id: userId, key: `private:${userId}` };

  return null;
}
