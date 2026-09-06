// entity.h - 实体定义（玩家/怪物/精英/NPC/掉落物），预留扩展位
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <array>
#include <vector>
#include <cstdint>
#include <cmath>
#include "util/json.h"
#include "game/items.h"
#include "game/quests.h"
#include "game/warehouse.h"   // 仓库系统（阶段5：WarehouseData）
namespace ew {
struct Vec3 {
  double x = 0, y = 0, z = 0;
  double dist2D(const Vec3& o) const { double dx = x - o.x, dz = z - o.z; return std::sqrt(dx*dx + dz*dz); }
  double dist3D(const Vec3& o) const { double dx = x - o.x, dy = y - o.y, dz = z - o.z; return std::sqrt(dx*dx+dy*dy+dz*dz); }
};
enum class EntityKind { Player, Monster, Npc, Item };
// 精英行为状态（服务端权威，全区共享）
enum EliteState : uint8_t {
  ES_IDLE = 0,    // 脱战/回血
  ES_ENGAGE = 1,  // 有仇恨目标
  ES_DEAD = 2,    // 死亡/复活计时
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
  bool dead = false;   // 死亡状态（玩家死亡后复活等待；怪物用 active=false 表达死亡）
  // 玩家扩展字段
  std::string username;
  // 显示名（世界实体：怪物/精英/NPC 用）
  std::string name;
  // 怪物类型 key（wolf/goblin/skeleton/gargoyle，供属性/掉落表查询）
  std::string monsterType;
  // 战斗/生命（世界怪物 & 世界精英状态共享的基础，服务端权威）
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
    uint64_t exp = 0;                                   // 累计经验（升级系统；当前等级见 Entity.level）
    // —— 装备实例化（每件独立，携带强化等级）——
    std::array<ItemInstance, 6> equip = {};             // 已穿戴装备实例（槽位值-1 下标，instId=0 为空）
    std::vector<ItemInstance> equipBag;                 // 背包中的装备实例（不可堆叠）
    // —— 堆叠物品（消耗品/材料/任务道具）——
    std::unordered_map<uint32_t, uint32_t> inventory;   // itemId -> 数量
    uint32_t openShopId = 0;                            // 当前打开的商店 ID（0=未打开）
    // —— 商店限购追踪（阶段1：限购/每日每周刷新）——
    std::unordered_map<uint64_t, uint32_t> shopBuyCount; // key=(shopId<<32|itemId) → 已购数
    uint64_t shopRefreshMs = 0;                          // 上次限购刷新时刻（logicNowMs 基准）
    // —— 仓库（阶段5：多页存储 + 存金，随存档持久化，见 warehouse.h）——
    WarehouseData warehouse;                             // 玩家仓库数据（gold/unlocked/slots）
  } pl;
  // 掉落物专属（EntityKind::Item）：itemId=0 表示纯金币
  uint32_t dropItemId = 0;
  uint32_t dropGold = 0;
  ItemInstance dropInst;             // 装备掉落实例（dropInst.instId!=0 时为装备，拾取后直接入背包保留强化）
  uint64_t dropExpireAtMs = 0;   // 掉落物消失时刻
  // 技能系统（大型网游规模，数据驱动）
  std::unordered_set<uint32_t> learnedSkills;        // 已学习技能 ID
  std::unordered_map<uint32_t, uint64_t> skillCd;    // 技能冷却：skillId -> readyAtMs（服务端权威单调时钟）
  std::vector<uint32_t> skillIds;                    // 运行时可用技能 ID（由 MonsterDef 数据驱动）
  struct Buff {
    uint32_t skillId = 0;   // 来源技能
    uint8_t type = 0;       // BuffType（skills.h）
    double value = 0;       // 数值（ATK/DEF 平值 / MOVE_SLOW,THORNS 比例 / REGEN 每秒回血）
    double remainSec = 0;   // 剩余时长（秒）
    double durationSec = 0; // 总时长（秒，供 UI 展示）
  };
  std::vector<Buff> buffs;  // 自身 Buff 列表（buffSystem 每 tick 衰减）
  // 是否挂有指定类型的 Buff（且未过期）——眩晕/霸体/减速等状态查询
  bool hasBuff(uint8_t type) const {
    for (const auto& b : buffs) if (b.type == type && b.remainSec > 0) return true;
    return false;
  }
  // 施放中（前摇）状态：castingSkillId != 0 表示正在施放，到期由 castSystem 结算
  uint32_t castingSkillId = 0;
  uint64_t castStartMs = 0; // 开始施放时刻（服务端单调时钟 ms）
  uint32_t castTargetWid = 0;
  double castTx = 0, castTz = 0; // 施放落点（用于 AOE）
  bool dashPending = false;      // 位移技能执行后待通知客户端校正（executeDash 置 true，网络层消费后清 false）
  // 任务系统（大型网游规模，数据驱动）
  std::vector<ActiveQuest> activeQuests;            // 进行中的任务
  std::unordered_set<uint32_t> completedQuests;     // 已完成任务 ID 集合
  std::unordered_map<uint32_t, uint64_t> questCooldown; // 日常任务冷却：questId -> nextAvailableMs
  // NPC 专属：所属商店 ID（0=普通 NPC）
  uint32_t shopId = 0;
  std::string npcId;          // NPC 唯一 ID（引用 NpcManager 中的 NpcDef，空=非 NPC 实体）
  uint32_t npcTag = 0;        // NPC 标签位标志（NpcTag 组合，客户端据此渲染交互菜单）
  bool isElite = false;         // 是否为世界精英（全局共享实体）
  uint64_t lastAttackMs = 0;    // 攻击冷却（服务端单调时钟 ms）
  uint64_t lastDamageMs = 0;    // 最近受击时刻（脱战回血判定）
  uint64_t respawnAtMs = 0;     // 死亡后复活时刻（服务端单调时钟 ms）
  // 精英共享状态（单点权威，全区广播）
  uint8_t eliteState = ES_IDLE;  // EliteState
  uint8_t elitePhase = 1;
  uint32_t eliteTarget = 0;      // 当前仇恨目标 wid（0=无）
  std::unordered_map<uint32_t, double> aggro;  // 仇恨表：玩家 wid -> 仇恨值
  // AI 扩展字段（生物/NPC/精英通用状态机 + 大规模调度）
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
    double stuckT = 0;       // 卡住计时（有移动意图但位移≈0，用于空洞/悬崖前解卡）
    // --- 确定性巡逻（去随机化）：固定 waypoint 环（服务端权威，客户端按广播意图外推）---
    int wpIdx = 0;           // 当前 waypoint 序号
    int wpCount = 6;         // waypoint 数量
    double wpPhase = 0;      // 环相位（出生点确定性哈希，同 seed 跨服一致）
    double wpR = 8.0;        // 环半径（米）
    bool wpInit = false;     // 是否已初始化 waypoint 环
    // --- 恢复态（仇恨态→恢复态→游走态）---
    double recoverWpX = 0, recoverWpZ = 0; // 进入仇恨态时记录的轨迹点位置
    double chaseTime = 0;    // 仇恨态连续追击时间（秒），进入战斗态时重置
    bool invincible = false; // 无敌标志（恢复态期间免疫所有伤害）
    // --- 大规模 AI 调度（时间片轮转 + 距离分级）---
    uint32_t tickStride = 1; // 每 N tick 更新一次（AI LOD，由调度器维护）
  } ai;
  // 当前移动速度倍率 0..1（多减速 Buff 取最大；100% = 无减速）。服务端/协议共用，
  // 用于广播"速度倍率（含减速 buff）"与移动目标速度计算（与 slowedSpeed 一致）。
  double moveScale() const {
    double slow = 0;
    for (const auto& b : buffs)
      if (b.type == 3 && b.remainSec > 0) slow = std::max(slow, b.value); // BuffType::MOVE_SLOW
    double s = 1.0 - slow;
    return s < 0 ? 0.0 : s;
  }
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
  int terrainRejects = 0;   // 地形软失败次数（双端判定分歧，不计入 violations、永不踢出）
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
// 制造一个地面掉落物实体（inst.instId!=0 时为装备实例掉落，保留强化等级）
Entity makeDrop(const std::string& id, double x, double y, double z,
                uint32_t itemId, uint32_t gold, const ItemInstance& inst = ItemInstance{});
} // namespace ew
