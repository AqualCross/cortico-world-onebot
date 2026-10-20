/**
 * WorldDefinition：默认配置、预检、实例工厂和自描述。
 * create() 必须保持纯：不连 WS、不发请求。
 */
import { createRequire } from 'node:module';

import { DEFAULTS, ID, LABEL } from './config.js';
import { OneBotWorld, ONEBOT_TOOL_DECLS } from './world.js';

const TOOL_SUMMARIES = {
  onebot_actions: {
    zh: '查 OneBot action 目录、参数 Schema 和分类。',
    en: "Look up the OneBot action catalog, JSON Schemas and categories.",
  },
  onebot_call: {
    zh: '调用任意 OneBot action；只读直接执行，写操作需要 confirm=true。',
    en: 'Call any OneBot action; reads run immediately, writes need confirm=true.',
  },
  onebot_events: {
    zh: '按类型和时间查已归档的 OneBot 事件。',
    en: 'Read archived OneBot events by kind and time.',
  },
  onebot_view_image: {
    zh: '把图片 URL 或图片 file_id 下载成模型能看的附件。',
    en: 'Download an image URL or image file_id as an attachment the model can see.',
  },
  onebot_status: {
    zh: '看 OneBot 连接、账号、catalog 来源和当前策略。',
    en: 'Show OneBot connection, account, catalog source and current policy.',
  },
};

function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const onebotDefinition = {
  id: ID,
  label: LABEL,
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    try {
      createRequire(import.meta.url).resolve('ws');
    } catch {
      throw new Error('找不到 ws：先在扩展目录安装依赖（pnpm install / npm install），再重启应用。');
    }
  },
  create: (ctx) => new OneBotWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
  }),
  describe: {
    tools: describeTools(ONEBOT_TOOL_DECLS),
    events: [
      {
        type: 'onebot.message',
        description: {
          zh: '一条 QQ 消息；正文是可读的一行，meta.raw 是原始 OneBot 事件。',
          en: 'A QQ message; text is a readable line and meta.raw is the original OneBot event.',
        },
        trigger: 'debounce',
      },
      {
        type: 'onebot.event',
        description: {
          zh: '未专门投影的 OneBot 事件（notice/request/meta_event 等）；正文是一行摘要，meta.raw 是原始事件。',
          en: 'An OneBot event that is not specially projected (notice/request/meta_event, etc.); text is a compact line and meta.raw is the original event.',
        },
        trigger: 'debounce',
      },
      {
        type: 'onebot.connection',
        description: {
          zh: 'OneBot 连接建立或断开。',
          en: 'OneBot connected or disconnected.',
        },
        trigger: 'debounce',
      },
    ],
  },
};

export default onebotDefinition;
