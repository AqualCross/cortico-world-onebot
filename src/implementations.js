/**
 * OneBot 实现识别。
 *
 * 靠 get_version_info 的 app_name 判断对端是哪个实现。识别不出来就原样用
 * 对端自报的名字，让控制台能直接看出连的是谁，而不是笼统的“已连接”。
 */

const KNOWN = [
  { id: 'snowluma', match: /snowluma/i },
  { id: 'napcat', match: /napcat/i },
  { id: 'llonebot', match: /llonebot/i },
  { id: 'lagrange', match: /lagrange/i },
  { id: 'go-cqhttp', match: /go-?cqhttp/i },
];

export function detectImplementation(version) {
  const name = String(version?.app_name ?? '').trim();
  const known = KNOWN.find((entry) => entry.match.test(name));
  return {
    id: known?.id ?? '',
    label: known ? known.id : (name || 'onebot11'),
  };
}
