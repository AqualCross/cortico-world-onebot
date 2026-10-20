/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * package.json 里 cortico.kind = world、cortico.api = 6。
 */
import definition, { onebotDefinition } from './definition.js';

export default definition;
export { onebotDefinition };
export { OneBotWorld, ONEBOT_TOOL_DECLS } from './world.js';
export {
  ID as ONEBOT_WORLD_ID,
  DEFAULTS as ONEBOT_DEFAULTS,
  EVENT_MESSAGE as ONEBOT_MESSAGE_EVENT,
  EVENT_RAW as ONEBOT_RAW_EVENT,
  EVENT_CONNECTION as ONEBOT_CONNECTION_EVENT,
} from './config.js';
