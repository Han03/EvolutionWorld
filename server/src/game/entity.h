// entity.h - 实体定义（玩家/怪物/Boss/NPC/掉落物），预留扩展位
#pragma once
#include <string>
#include <unordered_map>
#include <array>
#include <cstdint>
#include <cmath>
#include "util/json.h"
namespace ew {
struct Vec3 {
  double x = 0, y = 0, z = 0;
  double dist2D(const Vec3& o) const { double dx = x - o.x, dz = z - o.z; return std::sqrt(dx*dx + dz*dz); }
  double dist3D(const Vec3& o) const { double dx = x - o.x, dy = y - o.y, dz = z - o.z; return std::sqrt(dx*dx+dy*dy+dz*dz); }
};
enum class EntityKind { Player, Monster, Npc, Item };
// Boss 行为状态（服务端权威，全区共享）
enum BossState : uint8_t {
  BS_IDLE = 0,    // 脱战/回血
  BS_ENGAGE = 1,  // 有仇恨目标
  BS_DEAD = 2,    // 死亡/复活计时
};
struct Entity {
  std::string id;
  uint32_t wid = 0;   // 线上实体 ID（二进制协议使用，u32）
  EntityKind kind = EntityKind::Monster;
  Vec3 pos;
  Vec3 vel;
  double radius = 0.5;
  bool grounded = false;
  bool active = true;
  // 玩家扩展字段
  std::string username;
  // 显示名（世界实体：怪物/Boss/NPC 用）
  std::string name;
  // 怪物类型 key（wolf/goblin/skeleton/gargoyle，供属性/掉落表查询）
  std::string monsterType;
  // 战斗/生命（世界怪物 & 世界 Boss 状态共享的基础，服务端权威）
  double hp = 100, maxHp = 100;
  double mp = 50, maxMp = 50;   // 蓝量（属性系统）
  double attack = 10;
  double defense = 0;           // 防御力（属性系统：减伤）
  int level = 1;
  // 玩家专属数据（属性/物品/商店/掉落）
  struct {
    // 基础属性（等级成长，装备加成在 maxHp/maxMp/attack/defense 上叠加，服务端权威）
    double baseHp = 100, baseMp = 50, baseAttack = 12, baseDefense = 3;
    uint32_t gold = 0;                                  // 金币（也是物品）
    std::array<uint32_t, 6> equip = {};                 // 已穿戴装备 itemId（槽位值-1 下标，0=空）
    std::unordered_map<uint32_t, uint32_t> inventory;   // 背包：itemId -> 数量
    uint32_t openShopId = 0;                            // 当前打开的商店 ID（0=未打开）
  } pl;
  // 掉落物专属（EntityKind::Item）：itemId=0 表示纯金币
  uint32_t dropItemId = 0;
  uint32_t dropGold = 0;
  uint64_t dropExpireAtMs = 0;   // 掉落物消失时刻
  // NPC 专属：所属商店 ID（0=普通 NPC）
  uint32_t shopId = 0;
  bool isBoss = false;          // 是否为世界 Boss（全局共享实体）
  uint64_t lastAttackMs = 0;    // 攻击冷却（服务端单调时钟 ms）
  uint64_t lastDamageMs = 0;    // 最近受击时刻（脱战回血判定）
  uint64_t respawnAtMs = 0;     // 死亡后复活时刻（服务端单调时钟 ms）
  // Boss 共享状态（单点权威，全区广播）
  uint8_t bossState = BS_IDLE;  // BossState
  uint8_t bossPhase = 1;
  uint32_t bossTarget = 0;      // 当前仇恨目标 wid（0=无）
  double bossSkillCd = 0;       // 范围技能冷却计时（秒）
  std::unordered_map<uint32_t, double> aggro;  // 仇恨表：玩家 wid -> 仇恨值
  // AI 扩展字段（生物/NPC/Boss 通用状态机 + 大规模调度）
  struct {
    double targetVX = 0, targetVZ = 0;
    double homeX = 0, homeZ = 0;
    double dirX = 0, dirZ = 0;
    double timer = 0;
    double speed = 1.0;
    // --- AI 状态机（AiState 枚举，见 ai.h）---
    uint8_t aiState = 0;     // 当前状态
    uint32_t targetWid = 0;  // 当前目标（仇恨/交互）
    double stateTime = 0;    // 当前状态持续时间（秒）
    double thinkCd = 0;      // 决策/行为冷却
    // --- 大规模 AI 调度（时间片轮转 + 距离分级）---
    uint32_t tickStride = 1; // 每 N tick 更新一次（AI LOD，由调度器维护）
  } ai;
  // 输入状态（由网络层/防作弊写入，输入系统消费）
  struct {
    double moveX = 0, moveZ = 0;
    bool jump = false;
    double targetVX = 0, targetVZ = 0; // 输入系统计算结果
  } input;
  // 防作弊/追踪字段（由 AntiCheat 维护）
  int64_t lastSeq = 0;
  uint64_t lastAcceptMs = 0;
  int acceptedInputs = 0;
  int violations = 0;
  int rateDrops = 0;
  // 区块归属（ChunkManager 维护）
  std::string __chunkKey;
  Json serialize() const;
};
// 工厂
Entity makePlayer(const std::string& id, const std::string& username);
// 按怪物类型（wolf/goblin/...）从 GameData 配置取属性；type 为空用默认
Entity makeMonster(const std::string& id, const std::string& type);
Entity makeNpc(const std::string& id);
// 制造一个地面掉落物实体
Entity makeDrop(const std::string& id, double x, double y, double z,
                uint32_t itemId, uint32_t gold);
} // namespace ew
