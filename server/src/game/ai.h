// ai.h - 大型网游 AI 框架：状态机 + 大规模调度
//
// 设计要点（对应大型网游规模）：
//  1. 统一状态机：生物/NPC/Boss 共用 AiState，行为可组合、可扩展
//  2. 感知层：半径侦测 + 仇恨表（玩家攻击/靠近累积仇恨，脱战衰减）
//  3. 调度层（关键）：
//     - 时间片轮转：用 wid 做相位偏移，把同档位实体的 AI 计算摊到不同 tick，避免帧峰
//     - 距离分级（AI LOD）：距最近玩家越近更新越频繁；远处降频
//     - AOI 激活：仅玩家视野内（chunks 可见）实体才跑完整 AI，出视野休眠
//  4. 服务端权威：所有行为在服务端模拟，客户端只消费状态（防作弊 + 状态共享）
#pragma once
#include <cstdint>
#include "game/entity.h"
namespace ew {
class World;
class Config;

// 生物/NPC/Boss 通用 AI 状态
enum AiState : uint8_t {
  AS_IDLE = 0,     // 待机（无目标，等待）
  AS_PATROL = 1,   // 巡逻：围绕出生点随机游走（生物）
  AS_CHASE = 2,    // 追击：朝仇恨目标移动
  AS_ATTACK = 3,   // 近战攻击：目标在攻击范围内
  AS_RETURN = 4,   // 回巢：超出追击距离/巡逻半径后返回出生点
  AS_WANDER = 5,   // 随机游走（NPC 低频行为）
  AS_INTERACT = 6, // 交互（NPC 预留：对话/商店/任务）
  AS_DEAD = 7,     // 死亡（复活计时）
};

// AI 调度器：决定某个实体本 tick 是否更新 AI
class AiScheduler {
public:
  explicit AiScheduler(const Config& cfg) : cfg_(cfg) {}
  // 返回 true 表示该实体本 tick 应执行 AI（AOI 激活 + 时间片 + 距离分级）
  bool shouldTick(World& w, Entity& e, uint64_t tick);
private:
  const Config& cfg_;
};

// 生物（Monster）状态机：IDLE/PATROL → CHASE/ATTACK → RETURN →（复活）
void tickMonsterAi(World& w, Entity& e, double dt);
// NPC 状态机：IDLE/WANDER（预留 INTERACT）
void tickNpcAi(World& w, Entity& e, double dt);
// 世界 Boss 状态机：IDLE（回血/侦测）→ ENGAGE（追击/普攻/AOE/阶段）→ DEAD（复活）
void tickBossAi(World& w, Entity& e, double dt);

// 工具：选取仇恨最高的存活玩家目标（无则返回 nullptr）
Entity* pickAggroTarget(World& w, Entity& e);
// 工具：向目标水平移动（返回是否已进入 arriveDist）
bool moveToward(Entity& e, const Vec3& target, double speed, double arriveDist);
} // namespace ew
