import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfig } from '../src/config.js';
import { actionPolicy, eventPolicy, matcher } from '../src/policy.js';

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
