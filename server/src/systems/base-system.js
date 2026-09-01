/**
 * 系统基类 —— 可扩展性的核心。
 *
 * 世界由一组「系统」驱动：每个系统实现 update(dt)，在固定的 tick 内按注册顺序执行。
 * 新增玩法（战斗、任务、聊天、掉落、AI 行为树……）只需：
 *   1. 继承 BaseSystem
 *   2. 实现 update(dt)（或 onEvent）
 *   3. 在 world 中注册（见 world-manager.js 的 createDefaultSystems）
 * 即可接入，不影响既有系统。
 */
export class BaseSystem {
  constructor(world, config) {
    this.world = world;
    this.config = config;
    /** 系统优先级：越小越先执行 */
    this.priority = 100;
    /** 是否启用（可动态开关） */
    this.enabled = true;
  }

  /** 每帧调用 */
  update(_dt) {}

  /** 世界事件订阅（可覆写） */
  onEvent(_eventName, _payload) {}
}
