import test from 'node:test';
import assert from 'node:assert/strict';

import { capText, compactJson, eventKind, renderMessage, renderSegment } from '../src/render.js';

test('eventKind: stable message kinds, notice subtypes included', () => {
  assert.equal(eventKind({ post_type: 'message', message_type: 'group', sub_type: 'normal' }), 'message/group');
  assert.equal(eventKind({ post_type: 'message', message_type: 'private', sub_type: 'friend' }), 'message/private');
  assert.equal(eventKind({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' }), 'notice/notify/poke');
  assert.equal(eventKind({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), 'meta_event/heartbeat');
  assert.equal(eventKind({ post_type: 'request', request_type: 'friend' }), 'request/friend');
});

test('renderSegment: common segments and unknown fallback', () => {
  assert.equal(renderSegment({ type: 'text', data: { text: 'hi' } }), 'hi');
  assert.equal(renderSegment({ type: 'at', data: { qq: 'all' } }), '@全体成员');
  assert.equal(renderSegment({ type: 'reply', data: { id: 42 } }), '[回复 #42]');
  assert.equal(renderSegment({ type: 'image', data: { file: 'a.png' } }), '[图片 a.png]');
  assert.equal(renderSegment({ type: 'mystery', data: {} }), '[mystery]');
});

test('renderMessage: readable line with sender, body and message id', () => {
  const text = renderMessage({
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    user_id: 456,
    message_id: 789,
    time: 1700000000,
    sender: { card: 'A' },
    message: [
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: 'all' } },
    ],
  }, 'UTC');

  assert.match(text, /^\[群123 /);
  assert.match(text, /A\(456\): hi @全体成员 #789$/);
});

test('compactJson and capText truncate deterministically', () => {
  const long = { text: 'x'.repeat(100) };
  const compact = compactJson(long, 20);
  assert.match(compact, /truncated \d+ chars/);
  assert.equal(capText('abc', 10), 'abc');
  assert.equal(capText('abcdef', 3), 'abc…[truncated 3 chars]');
});
