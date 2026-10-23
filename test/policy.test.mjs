import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfig } from '../src/config.js';
import { actionPolicy, eventPolicy, matcher, receivePolicy } from '../src/policy.js';
import { conversationOf } from '../src/conversations.js';

test('matcher: exact, glob, category string', () => {
  const m = matcher(['set_group_*', 'get_msg', 'category:群管理']);
  assert.equal(m.match('set_group_ban'), true);
  assert.equal(m.match('get_msg'), true);
  assert.equal(m.match('category:群管理'), true);
  assert.equal(m.match('send_group_msg'), false);
  assert.equal(m.match(undefined), false);
});

test('action policy: name, alias, glob and category', () => {
  const cfg = readConfig({
    actions: {
      disabled: 'set_group_*, category:群管理',
      disabledCategories: '系统',
    },
  });
  const policy = actionPolicy(cfg);

  assert.equal(policy.disabled({ name: 'set_group_ban', aliases: [], category: '群管理' }, 'set_group_ban'), true);
  assert.equal(policy.disabled({ name: 'get_msg', aliases: [], category: '消息' }, 'get_msg'), false);
  assert.equal(policy.disabled({ name: 'bot_exit', aliases: [], category: '系统' }, 'bot_exit'), true);
  assert.equal(policy.disabled({ name: 'send_msg', aliases: ['send'], category: '消息' }, 'send'), false);

  const aliasPolicy = actionPolicy(readConfig({ actions: { disabled: 'alias_name' } }));
  assert.equal(
    aliasPolicy.disabled({ name: 'real_name', aliases: ['alias_name'], category: '消息' }, 'real_name'),
    true,
  );
});

test('conversation: group events use group_id, private events use user_id', () => {
  assert.deepEqual(
    conversationOf({ post_type: 'message', message_type: 'group', group_id: 123, user_id: 456 }),
    { kind: 'group', id: 123, key: 'group:123' },
  );
  assert.deepEqual(
    conversationOf({ post_type: 'message', message_type: 'private', user_id: 456 }),
    { kind: 'private', id: 456, key: 'private:456' },
  );
  // 群通知与入群请求也归到群，不能因为不是消息就绕过接收名单。
  assert.equal(conversationOf({ post_type: 'notice', group_id: 123, user_id: 456 }).key, 'group:123');
  assert.equal(conversationOf({ post_type: 'request', group_id: 123, user_id: 456 }).key, 'group:123');
  assert.equal(conversationOf({ post_type: 'notice', user_id: 456 }).key, 'private:456');
  // message_sent 的 user_id 是 bot 自己，私聊目标在 target_id。
  assert.equal(
    conversationOf({ post_type: 'message_sent', message_type: 'private', user_id: 10001, target_id: 456 }).key,
    'private:456',
  );
  assert.equal(conversationOf({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
});

test('receive policy: * all, empty none, group/private globs', () => {
  const all = receivePolicy(readConfig({}));
  assert.deepEqual(all.patterns, ['*']);
  assert.equal(all.all, true);
  assert.equal(all.receive('group:123'), true);
  assert.equal(all.receive('private:456'), true);
  // meta_event 没有会话，不受名单管。
  assert.equal(all.receive(null), true);

  const some = receivePolicy(readConfig({ conversations: { receive: 'group:1*, private:456' } }));
  assert.deepEqual(some.patterns, ['group:1*', 'private:456']);
  assert.equal(some.all, false);
  assert.equal(some.receive('group:123'), true);
  assert.equal(some.receive('group:999'), false);
  assert.equal(some.receive('private:456'), true);
  assert.equal(some.receive('private:999'), false);

  const none = receivePolicy(readConfig({ conversations: { receive: '' } }));
  assert.deepEqual(none.patterns, []);
  assert.equal(none.receive('group:123'), false);
});

test('event policy: drop > mute > deliver', () => {
  const policy = eventPolicy(readConfig({
    events: {
      deliver: '*',
      mute: 'meta_event/*',
      drop: 'meta_event/heartbeat',
    },
  }));

  assert.equal(policy.drop('meta_event/heartbeat'), true);
  assert.equal(policy.drop('meta_event/lifecycle'), false);
  assert.equal(policy.mute('meta_event/lifecycle'), true);
  assert.equal(policy.deliver('meta_event/lifecycle'), false);
  assert.equal(policy.deliver('message/group'), true);
  assert.equal(policy.deliver('notice/group_recall'), true);
});
