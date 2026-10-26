import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCatalog } from '../src/catalog.js';
import {
  checkActionParams,
  checkActionUrls,
  checkLocalPath,
  collectInputRefs,
  normalizeReadPaths,
  readPathsOf,
} from '../src/file-policy.js';

const catalog = loadCatalog({ impl: 'snowluma' });
const spec = (name) => catalog.resolve(name);

function tempRoot(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'onebot-policy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('readPathsOf: 数组与换行串都认，空值给空列表', () => {
  assert.deepEqual(readPathsOf({ files: { readPaths: ['C:\\a', 'C:\\b'] } }), ['C:\\a', 'C:\\b']);
  assert.deepEqual(readPathsOf({ files: { readPaths: 'C:\\a\n\nD:\\b\n' } }), ['C:\\a', 'D:\\b']);
  assert.deepEqual(readPathsOf({}), []);
});

test('normalizeReadPaths: 只收绝对路径，去重', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(normalizeReadPaths(`${root}\n${root}\n`), [root]);
  assert.throws(() => normalizeReadPaths('relative/dir'), /must be absolute/);
});

test('checkLocalPath: URL 不读本地，裸文件名只读动作才放过', (t) => {
  const root = tempRoot(t);
  const allowed = [root];
  for (const url of ['https://example.com/a.png', 'http://127.0.0.1/a', 'base64://AAAA', 'data:image/png;base64,AA']) {
    assert.equal(checkLocalPath(url, allowed), null);
  }
  assert.equal(checkLocalPath('abc.png', allowed, { tokenOk: true }), null);
  assert.equal(checkLocalPath('abc.png', allowed), 'is a relative path');
  assert.equal(checkLocalPath('sub/abc.png', allowed, { tokenOk: true }), 'is a relative path');
  assert.equal(checkLocalPath('..\\secret.txt', allowed, { tokenOk: true }), 'is a relative path');
});

test('checkLocalPath: 绝对路径必须在白名单内', (t) => {
  const root = tempRoot(t);
  const outside = tempRoot(t);
  writeFileSync(join(root, 'voice.amr'), 'x');
  assert.equal(checkLocalPath(join(root, 'voice.amr'), [root]), null);
  assert.equal(checkLocalPath(join(root, 'missing.amr'), [root]), 'does not exist');
  assert.equal(checkLocalPath(join(outside, 'voice.amr'), [root]), 'is outside the allowed read paths');
  assert.equal(checkLocalPath(pathToFileURL(join(root, 'voice.amr')).href, [root]), null);
  assert.equal(checkLocalPath(join(outside, 'voice.amr'), []), 'is blocked because no read paths are allowed');
  assert.match(checkLocalPath('C:\\a\0b', [root]), /NUL/);
});

test('collectLocalRefs: 文件参数、消息段、CQ 码和 files 数组', (t) => {
  const root = tempRoot(t);
  const outside = tempRoot(t);
  const inside = join(root, 'a.png');
  writeFileSync(inside, 'x');
  const blocked = join(outside, 'a.png');

  const upload = spec('upload_group_file');
  assert.equal(checkActionParams(upload, { group_id: 1, file: inside }, { files: { readPaths: [root] } }), null);
  assert.deepEqual(
    checkActionParams(upload, { group_id: 1, file: blocked }, { files: { readPaths: [root] } }),
    { path: blocked, via: 'file', reason: 'is outside the allowed read paths' },
  );
  assert.equal(
    checkActionParams(upload, { group_id: 1, file: 'config.json' }, { files: { readPaths: [root] } }).reason,
    'is a relative path',
  );

  const send = spec('send_group_msg');
  const segment = { group_id: 1, message: [{ type: 'image', data: { file: blocked } }] };
  assert.equal(checkActionParams(send, segment, { files: { readPaths: [root] } }).reason, 'is outside the allowed read paths');
  assert.equal(
    checkActionParams(send, { group_id: 1, message: [{ type: 'image', data: { url: 'https://example.com/a.png' } }] }, {}),
    null,
  );
  assert.equal(
    checkActionParams(send, { group_id: 1, message: [{ type: 'record', data: { file: blocked } }] }, {}).via,
    'message[0].file',
  );
  assert.equal(
    checkActionParams(send, { group_id: 1, message: `[CQ:image,file=${blocked}]` }, {}).via,
    'message.CQ:image',
  );

  const flash = spec('create_flash_task');
  assert.equal(
    checkActionParams(flash, { files: [{ file: blocked, name: 'x' }] }, {}).via,
    'files[0].file',
  );

  const notice = spec('_send_group_notice');
  assert.equal(checkActionParams(notice, { group_id: 1, content: 'x', image: blocked }, {}).via, 'image');
});

test('collectInputRefs: 只读 action 的缓存文件名不当作路径', () => {
  const refs = collectInputRefs(spec('get_image'), { file: 'abc.image' });
  assert.deepEqual(refs, [{ via: 'file', value: 'abc.image' }]);
  assert.equal(checkActionParams(spec('get_image'), { file: 'abc.image' }, {}), null);
});

test('checkActionUrls: 实现对端要拉取的 URL 必须是公网地址', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateUrl = 'http://127.0.0.1:6099/api';

  assert.deepEqual(
    await checkActionUrls(spec('download_file'), { url: privateUrl }, {}),
    { url: privateUrl, via: 'url', reason: 'blocked address: 127.0.0.1' },
  );
  assert.equal(
    (await checkActionUrls(
      spec('send_group_msg'),
      { group_id: 1, message: [{ type: 'image', data: { url: privateUrl } }] },
      {},
    )).via,
    'message[0].url',
  );
  assert.equal(
    (await checkActionUrls(spec('comment_qzone'), { images: [privateUrl] }, {})).via,
    'images[0]',
  );
  assert.equal(
    (await checkActionUrls(spec('_send_group_notice'), { group_id: 1, content: 'x', image: privateUrl }, {})).via,
    'image',
  );

  // 纯文本里的链接不是取数目标，不拦。
  assert.equal(
    await checkActionUrls(spec('send_group_msg'), { group_id: 1, message: '见 http://127.0.0.1/x' }, {}),
    null,
  );
  assert.equal(
    await checkActionUrls(spec('download_file'), { url: 'https://images.example/a.png' }, {}, { lookup: publicLookup }),
    null,
  );
  assert.equal(
    await checkActionUrls(
      spec('download_file'),
      { url: 'https://images.example/a.png' },
      { images: { allowPrivateHosts: true } },
    ),
    null,
  );
});
