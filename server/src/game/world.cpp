// world.cpp - 世界管理器实现 + 世界怪物/世界精英状态共享（服务端单点权威）
#include "world.h"
#include "terrain.h"
#include "worldinit.h"
#include <cstdio>
#include "ai.h"
#include "net/protocol.h"
#include "store/store.h"
#include <algorithm>
#include <cmath>
namespace ew {
// 简易随机源（AI 用；单线程）
static Mulberry32 gAiRng(0xC0FFEE);
static double rng01() { return gAiRng.next(); }
// 世界精英固定锚点（确定性，可调）
// 世界精英锚点：远离城镇/出生点安全区（>=40m），且位于可通行地图区域（用与地形 mask 一致的采样选定）
// 默认系统（前向声明，定义在文件后部）
static void inputSystem(World& w, double dt);
static void moveSystem(World& w, double dt);
static void aiSystem(World& w, double dt);
static void castSystem(World& w, double dt);
static void buffSystem(World& w, double dt);
static void respawnSystem(World& w, double dt);
static void playerRespawnSystem(World& w, double dt);
static void dropSystem(World& w, double dt);
World::World(const Config& cfg)
    : cfg_(cfg), currentSeed_((uint32_t)cfg.worldSeed), physics_(cfg), chunks_(*this, cfg),
      aoi_(cfg.aoiCellSizeM), rng_((uint32_t)cfg.worldSeed ^ 0x51ab) {
  // 出生点布局不再硬编码：由世界初始化执行器（runWorldInit）数据驱动生成，
  // 或数据库模式从库还原（loadWorldFromStore）。构造时不填充默认布局。
  // 初始化社交系统
  friends_ = std::make_unique<FriendSystem>(*this);
  guilds_ = std::make_unique<GuildSystem>(*this);
  chat_ = std::make_unique<ChatSystem>(*this);
  quests_ = std::make_unique<QuestSystem>(*this);
  npcs_ = std::make_unique<NpcManager>();  // NPC 插件初始化
  economy_ = std::make_unique<EconomySystem>();  // 经济系统门面（强化/分解/合成）
  warehouse_ = std::make_unique<WarehouseSystem>();  // 仓库系统（阶段5：存储域）
  addSystem(10, "input", inputSystem);
  addSystem(20, "move", moveSystem);
  addSystem(30, "ai", aiSystem);
  addSystem(32, "cast", castSystem);
  addSystem(35, "buff", buffSystem);
  addSystem(50, "respawn", respawnSystem);
  addSystem(55, "player_respawn", playerRespawnSystem);
  addSystem(60, "drop", dropSystem);
  // 配置系统：从 data/*.json 加载游戏数据（items/monsters/shop/skills/player）
  data_.loadFromJson(cfg.dataDir);
  // NPC 插件：从 data/npcs.json 加载 NPC 定义
  npcs_->loadFromJson(cfg.dataDir);
  // 经济系统：从 data/enhance.json + data/craft.json 加载配置
  economy_->loadFromJson(cfg.dataDir);
  // 仓库系统：从 data/warehouse.json 加载配置
  warehouse_->loadFromJson(cfg.dataDir);
  // 任务系统：从 data/quests.json 加载任务定义
  quests_->init();
}
Store& World::store() {
  // 存储层引用（社交系统持久化用，由 main 通过 setStore 注入）
  return *store_;
}
void World::addSystem(int priority, const std::string& name, SystemFn fn) {
  systems_.push_back({priority, {name, std::move(fn)}});
  std::sort(systems_.begin(), systems_.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
}
std::string World::nextEntityId(const char* prefix) {
  return std::string(prefix) + "_" + std::to_string(++entitySeq_);
}
void World::addEntity(Entity&& e) {
  std::string id = e.id;
  if (e.wid == 0) e.wid = nextWireId();
  widToId_[e.wid] = id;
  entities_[id] = std::move(e);
  chunks_.updateEntityChunk(entities_[id]);
  aoi_.move(entities_[id].wid, entities_[id].pos.x, entities_[id].pos.z);
}
void World::seedWorld() {
  // 数据驱动出生点：从 spawns_（世界初始化生成 / 数据库还原 / 编辑器覆盖）刷出全部生物
  for (const auto& sp : spawns_.list()) spawnFromPoint(sp);
}
// ---- 世界初始化执行器 / 持久化（委托 worldinit.cpp）----
bool World::runWorldInit() {
  bool ok = generateWorld(*this, cfg_);
  fprintf(stderr, "[worldinit] 世界初始化%s：mask %dx%d 就绪=%d，出生点 %zu\n",
          ok ? "完成" : "失败", terrainWalkMaskN(), terrainWalkMaskN(),
          (int)terrainWalkMaskReady(), spawns_.size());
  return ok;
}
bool World::saveWorldToStore(Store& s) {
  return s.saveWorldData("world", worldDataToJson(spawns_));
}
bool World::loadWorldFromStore(Store& s) {
  std::string out;
  if (!s.loadWorldData("world", out) || out.empty()) return false;
  bool ok = worldDataFromJson(*this, out);
  if (ok)
    fprintf(stderr, "[worldinit] 从数据库还原世界：mask %dx%d，出生点 %zu\n",
            terrainWalkMaskN(), terrainWalkMaskN(), spawns_.size());
  return ok;
}
// 按出生点生成一只生物（monster/npc）
void World::spawnFromPoint(const SpawnPoint& sp) {
  if (sp.kind == SP_MONSTER) {
    // 相同怪物成群：群内围绕锚点小半径散布（确定性），避免完全重叠；
    // spawnMonster 会在附近自动寻找可通行干地，保证不落空洞/水中。
    if (sp.type.empty()) {
      fprintf(stderr, "[spawn] 警告：怪物出生点 type 为空，跳过 (%.1f,%.1f)\n", sp.x, sp.z);
      return;
    }
    const std::string& type = sp.type;
    int n = sp.count > 0 ? sp.count : 1;
    for (int i = 0; i < n; i++) {
      double ang = (double)i / (double)n * 6.283185307;
      double rr = (i == 0) ? 0.0 : 2.0 + (double)(i % 3) * 1.6;   // 0 / 2.0 / 3.6 / 5.2 米内散布
      spawnMonster(type, sp.x + std::cos(ang) * rr, sp.z + std::sin(ang) * rr);
    }
  } else if (sp.kind == SP_NPC) {
    spawnNpcAt(sp);
  }
}
// 按出生点生成一个城镇 NPC：就近找干地，可带商店/名称
// NPC 插件：按 npcId 查 NpcDef，应用属性 + 唯一性检查（相同 npcId 不能同时出现）
void World::spawnNpcAt(const SpawnPoint& sp) {
  // 唯一性检查：相同 npcId 不能同时出现在地图上
  if (!sp.npcId.empty() && !npcs_->markSpawned(sp.npcId)) {
    fprintf(stderr, "[npc] 拒绝重复生成 npcId=%s（已存在于地图上）\n", sp.npcId.c_str());
    return;
  }

  Entity n = makeNpc(nextEntityId("n"));
  double hx = sp.x, hz = sp.z;
  double sx = hx, sz = hz;
  bool found = false;
  for (double r = 0; r <= 12 && !found; r += 2) {
    for (int k = 0; k < 16 && !found; k++) {
      double a = (double)k / 16.0 * 6.28318;
      double px = hx + std::cos(a) * r, pz = hz + std::sin(a) * r;
      if (!terrainBlocked(px, pz) && terrainHeight(px, pz) > kWaterLevel + 1.0) { sx = px; sz = pz; found = true; }
    }
  }
  n.pos = {sx, groundFootY(sx, sz, n.radius), sz};
  n.ai.homeX = n.pos.x;
  n.ai.homeZ = n.pos.z;

  // NPC 插件：按 npcId 查 NpcDef 应用属性
  if (!sp.npcId.empty()) {
    const NpcDef* def = npcs_->npc(sp.npcId);
    if (def) {
      n.npcId = def->npcId;
      n.npcTag = def->npcTag;
      n.name = def->name;
      n.level = def->level;
      n.shopId = def->shopId;
      n.ai.wpR = def->wanderRadius;  // 游走半径
      n.radius = def->radius;         // 碰撞半径
      n.pos.y = groundFootY(n.pos.x, n.pos.z, n.radius); // 按新半径重算贴地
      if (def->shopId) n.ai.aiState = 0;  // 守店不游走
    } else {
      fprintf(stderr, "[npc] 警告：npcId=%s 未找到定义，回退到 SpawnPoint 字段\n", sp.npcId.c_str());
      n.npcId = sp.npcId;
      n.npcTag = sp.npcTag;
      if (!sp.name.empty()) n.name = sp.name;
      if (sp.shopId) { n.shopId = sp.shopId; n.ai.aiState = 0; }
    }
  } else {
    // 旧模式：无 npcId，使用 SpawnPoint 字段
    n.npcTag = sp.npcTag;
    if (!sp.name.empty()) n.name = sp.name;
    if (sp.shopId) { n.shopId = sp.shopId; n.ai.aiState = 0; }
  }

  if (n.shopId) {
    fprintf(stderr, "[npc] spawn npcId=%s name=%s pos=(%.2f,%.2f,%.2f) home=(%.2f,%.2f)\n",
            n.npcId.c_str(), n.name.c_str(), n.pos.x, n.pos.y, n.pos.z, n.ai.homeX, n.ai.homeZ);
  }
  addEntity(std::move(n));
}
// 热重载：清空现有种子生物（m_*/n_*/boss_*）并按当前出生点配置重建
void World::reseedCreatures() {
  std::vector<std::string> toRemove;
  for (const auto& [id, e] : entities_) {
    if (e.kind == EntityKind::Player) continue;
    if (id.rfind("m_", 0) == 0 || id.rfind("n_", 0) == 0)
      toRemove.push_back(id);
  }
  for (const auto& id : toRemove) despawnEntity(id);
  npcs_->clearSpawned();  // NPC 插件：清空唯一性追踪
  seedWorld();
  fprintf(stderr, "[spawns] 热重载完成：%zu 个出生点 → 重建世界生物\n", spawns_.size());
}
// 应用新出生点配置：fromJson → 热重载世界生物（数据库模式同步落库；内存模式重启即重置）
bool World::applySpawns(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  if (!spawns_.fromJson(json)) return false;
  // 数据库模式：同步将出生点（连同当前 mask）落库，保证重启后一致
  if (store_ && store_->worldDataPersistent()) saveWorldToStore(*store_);
  reseedCreatures();
  return true;
}
// 应用编辑器物品配置：热替换内存 items_（数据库模式同步落库；内存模式重启即重置）
bool World::applyItems(const std::string& itemsJson, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json arr = Json::parse(itemsJson);
    if (!data_.replaceItems(arr)) return false;
  } catch (...) { return false; }
  // 数据库模式：同步落库
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("items", itemsJson);
  fprintf(stderr, "[gamedata] 物品配置热重载：%zu 件\n", data_.items().size());
  return true;
}
// 应用编辑器生物配置：热替换内存 monsters_ → 热重载世界生物（数据库模式同步落库）
bool World::applyMonsters(const std::string& monstersJson, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(monstersJson);
    if (!data_.replaceMonsters(obj)) return false;
  } catch (...) { return false; }
  // 数据库模式：同步落库
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("monsters", monstersJson);
  reseedCreatures();
  fprintf(stderr, "[gamedata] 生物配置热重载：%zu 种\n", data_.monsters().size());
  return true;
}
// 应用编辑器 NPC 配置：热替换内存 npcs_ → 同步已生成 NPC 实体的标签/名称/商店（数据库模式同步落库）
bool World::applyNpcs(const std::string& npcsJson, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(npcsJson);
    if (!npcs_->replaceNpcs(obj)) return false;
  } catch (...) { return false; }
  // 同步已生成 NPC 实体的 npcTag/name/shopId（编辑器保存后立即生效，无需手动重新初始化世界）
  int synced = 0;
  for (auto& [id, e] : entities_) {
    if (e.kind != EntityKind::Npc || e.npcId.empty()) continue;
    const NpcDef* def = npcs_->npc(e.npcId);
    if (!def) continue;
    e.npcTag = def->npcTag;
    e.name = def->name;
    e.shopId = def->shopId;
    ++synced;
  }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("npcs", npcsJson);
  fprintf(stderr, "[npc] NPC 配置热重载：%zu 种，同步 %d 个已生成实体\n", npcs_->npcs().size(), synced);
  return true;
}
// 应用编辑器强化配置：热替换内存 enhance 配置（数据库模式同步落库）
bool World::applyEnhance(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(json);
    if (!economy_->enhance().replaceConfig(obj)) return false;
  } catch (...) { return false; }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("enhance", json);
  fprintf(stderr, "[economy] 强化配置热重载：%zu 级\n", economy_->enhance().config().levels.size());
  return true;
}
// 应用编辑器分解配置：热替换内存 decompose 规则（数据库模式同步落库）
bool World::applyDecompose(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(json);
    if (!economy_->enhance().replaceDecomposeConfig(obj)) return false;
  } catch (...) { return false; }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("decompose", json);
  fprintf(stderr, "[economy] 分解配置热重载：%zu 档\n", economy_->enhance().decomposeConfig().rules.size());
  return true;
}
// 应用编辑器合成配方：热替换内存 craft 配方（数据库模式同步落库）
bool World::applyCraft(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(json);
    if (!economy_->craft().replaceConfig(obj)) return false;
  } catch (...) { return false; }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("craft", json);
  fprintf(stderr, "[economy] 合成配方热重载：%zu 条\n", economy_->craft().recipes().size());
  return true;
}
// 应用编辑器商店配置：热替换内存 shops_（数据库模式同步落库）
bool World::applyShop(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(json);
    if (!data_.replaceShops(obj)) return false;
  } catch (...) { return false; }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("shops", json);
  fprintf(stderr, "[gamedata] 商店配置热重载：%zu 个\n", data_.shops().size());
  return true;
}
// 应用编辑器技能配置：热替换内存 skills_ + starterSkills_（数据库模式同步落库）
bool World::applySkills(const std::string& json, const std::string& dataDir) {
  (void)dataDir;
  try {
    Json obj = Json::parse(json);
    if (!data_.replaceSkills(obj)) return false;
  } catch (...) { return false; }
  if (store_ && store_->worldDataPersistent()) store_->saveWorldData("skills", json);
  fprintf(stderr, "[gamedata] 技能配置热重载：%zu 个, %zu 起始技能\n", data_.skills().size(), data_.starterSkills().size());
  return true;
}
Entity* World::spawnPlayer(const std::string& username, Vec3* spawnHint) {
  Entity p = makePlayer(nextEntityId("p"), username);
  // 应用 player.json 加载的玩家基础属性（覆盖 makePlayer 硬编码默认值）
  const auto& pd = data_.playerDefaults();
  p.hp = p.maxHp = pd.hp;
  p.mp = p.maxMp = pd.mp;
  p.attack = pd.attack;
  p.defense = pd.defense;
  p.level = pd.level;
  p.radius = pd.radius;
  p.wid = nextWireId();
  // 起始技能：新玩家自动习得默认技能（开箱即测）
  for (uint32_t sid : data_.starterSkills()) {
    if (data_.skill(sid)) {
      p.learnedSkills.insert(sid);
      p.skillCd[sid] = 0;
    }
  }
  if (spawnHint) {
    p.pos = *spawnHint;
  } else {
    // 玩家出生：主城圆盘开放空地（出生点附近无怪物，NPC 在旁）
    Mulberry32 rng((uint32_t)(username.size() * 2654435761u + (uint64_t)entitySeq_));
    double x, y, z;
    townSpawn(rng, x, y, z);
    p.pos = {x, groundFootY(x, z, p.radius), z};
  }
  std::string id = p.id; // 移动前保存 id
  widToId_[p.wid] = id;
  entities_[id] = std::move(p);
  chunks_.updateEntityChunk(entities_[id]);
  aoi_.move(entities_[id].wid, entities_[id].pos.x, entities_[id].pos.z);
  players_.insert(id);
  return &entities_[id];
}
void World::despawnPlayer(const std::string& id) {
  auto it = entities_.find(id);
  if (it != entities_.end()) {
    widToId_.erase(it->second.wid);
    aoi_.remove(it->second.wid);
    chunks_.removeEntity(it->second);
    entities_.erase(it);
  }
  players_.erase(id);
  chunks_.removePlayer(id);
}
Entity* World::findPlayerByUsername(const std::string& username) {
  for (const auto& pid : players_) {
    Entity* p = findEntity(pid);
    if (p && p->username == username) return p;
  }
  return nullptr;
}
// 玩家攻击世界实体（服务端权威校验 + 伤害/仇恨/死亡/复活）
bool World::playerAttack(const std::string& playerId, uint32_t targetWid, uint8_t slot) {
  (void)slot;
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player || p->dead) return false;  // 死亡不可攻击
  Entity* t = findByWid(targetWid);
  if (!t || !t->active) return false;
  if (t->kind != EntityKind::Monster) return false;  // 只可攻击世界怪物/Boss
  uint64_t nowMs = logicNowMs();
  // 攻击冷却（服务端权威，客户端不可伪造频率）；测试无消耗模式下跳过，便于快速重复击杀
  if (!testFlags_.noSkillCost &&
      nowMs - p->lastAttackMs < (uint64_t)(cfg_.playerAttackCdSec * 1000.0)) return false;
  // 范围判定
  if (p->pos.dist2D(t->pos) > cfg_.playerAttackRange) return false;
  p->lastAttackMs = nowMs;
  // 伤害公式（属性系统）：攻击力 × 浮动 ± 20% × 100/(100+防御)，最低 1 点
  double dmg = calcDamage(p->attack, t->defense, 0.8 + rng01() * 0.4);
  t->hp -= dmg;
  t->aggro[p->wid] += dmg;  // 仇恨表（世界共享核心状态）
  t->ai.chaseTime = 0;       // 被攻击时重置追击计时，避免追击超时误触发恢复态
  pushEvent(proto::EVT_DAMAGE, t->wid, (uint32_t)dmg, 0, 0);
  // 荆棘反伤：目标（怪物/精英）若有 THORNS Buff，反弹部分伤害给攻击者
  thornsReflect(*t, *p, dmg);
  if (t->hp <= 0) onVictimDeath(*t, *p, nowMs);
  return true;
}
// 目标死亡统一处理（普攻/技能共用）：怪物失活+复活计时+掉落（精英与普通怪物一致）
void World::onVictimDeath(Entity& victim, Entity& killer, uint64_t nowMs) {
  victim.hp = 0;
  // 击杀奖励经验（仅玩家击杀者）：按 MonsterDef.expReward
  if (killer.kind == EntityKind::Player) {
    const MonsterDef* kdef = victim.monsterType.empty() ? nullptr : data_.monster(victim.monsterType);
    uint32_t exp = kdef ? kdef->expReward : 0u;
    if (exp) grantExp(killer, exp);
    // 任务钩子：击杀怪物后检测任务进度
    quests_->onMonsterKill(killer, victim.monsterType);
  }
  // 失活 + 复活计时 + 掉落（精英与普通怪物完全一致）
  rollDrops(killer, victim);
  victim.active = false;
  victim.respawnAtMs = nowMs + (uint64_t)(cfg_.monsterRespawnSec * 1000.0);
  victim.aggro.clear();
  victim.buffs.clear();
  victim.vel = {0, 0, 0};
  pushEvent(proto::EVT_DEATH, victim.wid, killer.wid, 0, 0);
}
// 玩家获得经验：累加 + 循环升级（每级 +20HP/+8MP/+2ATK/+1DEF，升级回满血蓝）
void World::grantExp(Entity& p, uint32_t amount) {
  if (p.kind != EntityKind::Player || amount == 0) return;
  p.pl.exp += amount;
  while (p.level < 999 && p.pl.exp >= playerExpToNext(p.level)) {
    p.pl.exp -= playerExpToNext(p.level);
    p.level += 1;
    p.pl.baseHp += 20; p.pl.baseMp += 8; p.pl.baseAttack += 2; p.pl.baseDefense += 1;
    recomputeStats(p);
    p.hp = p.maxHp; p.mp = p.maxMp;
  }
  markStatsDirty(p.id);
}
// ---------- 技能系统（大型网游规模，数据驱动，服务端权威） ----------
bool World::learnSkill(const std::string& playerId, uint32_t skillId) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  if (!data_.skill(skillId)) return false;
  p->learnedSkills.insert(skillId);
  p->skillCd[skillId] = 0;  // 初始无冷却
  markSkillsDirty(playerId);
  return true;
}
// 施放技能：校验（已学/眩晕/冷却/耗蓝/施法距离）→ 扣蓝+冷却 → 施加效果 → 广播
// 开始施放技能（两阶段：前摇 → 结算）。返回是否成功开始施放。
//  - 非 SELF 技能校验施法距离（落点距施法者 ≤ range），超距拒绝
//  - castTimeMs==0：瞬发，直接结算（扣蓝/冷却/效果）
//  - castTimeMs>0 ：进入前摇（castingSkillId 置位 + 广播 EVT_SKILL_CASTING），
//                  由 castSystem 到期后 resolveCast；移动/受击打断（cancelCast）
// 施放距离容差（网络延迟补偿）：客户端预测位置与服务端权威位置存在分歧，
// 边缘距离判定加 0.5m 容差，减少“客户端认为在范围但服务端拒绝”的误判
static constexpr double kCastRangeTolerance = 0.5;

bool World::beginCast(const std::string& playerId, uint32_t skillId, uint32_t targetWid, double tx, double tz) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player || p->dead) return false;  // 死亡不可施放
  if (p->hasBuff((uint8_t)BuffType::STUN)) return false;  // 眩晕不可施放
  const SkillDef* sd = data_.skill(skillId);
  if (!sd) return false;
  if (!p->learnedSkills.count(skillId)) return false;  // 未学习
  uint64_t nowMs = logicNowMs();
  const bool freeCast = testFlags_.noSkillCost;  // 测试：无冷却/无蓝耗，便于重复施放同一技能
  auto cdit = p->skillCd.find(skillId);
  if (!freeCast && cdit != p->skillCd.end() && cdit->second > nowMs) return false;  // 冷却中
  if (!freeCast && p->mp < sd->manaCost) return false;  // 蓝量不足
  // 落点语义：SELF=自身位置；ENEMY/AOE=客户端指定落点
  double gx = tx, gz = tz;
  if (sd->target == SkillTarget::SELF) { gx = p->pos.x; gz = p->pos.z; }
  else if (sd->range > 0 && p->pos.dist2D({gx, 0, gz}) > sd->range + kCastRangeTolerance) {
    return false; // 施法距离（落点距施法者超过 range + 容差）
  }
  // 单目标 ENEMY 技能：校验目标实体存在+存活+在施法距离内
  if (sd->target == SkillTarget::ENEMY && targetWid > 0) {
    Entity* tgt = nullptr;
    for (auto& [id, e] : entities_) { (void)id; if (e.wid == targetWid) { tgt = &e; break; } }
    if (!tgt || !tgt->active || tgt->dead) return false;  // 目标无效/已死亡
    if (sd->range > 0 && p->pos.dist2D(tgt->pos) > sd->range + kCastRangeTolerance) return false;  // 目标超距（含容差）
  }
  // 霸体技能：施放即挂 SUPER_ARMOR（免疫眩晕/击退），持续 = 前摇 + 0.5s 尾部余量
  if (sd->superArmor) {
    double armDur = (sd->castTimeMs > 0 ? sd->castTimeMs : 0) / 1000.0 + 0.5;
    applyBuff(*p, skillId, (uint8_t)BuffType::SUPER_ARMOR, 1.0, armDur);
  }
  // 前摇：进入施放中状态（覆盖旧施放），广播前摇事件
  if (sd->castTimeMs > 0) {
    if (p->castingSkillId != 0) cancelCast(*p, 0); // 替换旧施放（reason=0 不广播取消）
    p->castingSkillId = skillId;
    p->castStartMs = nowMs;
    p->castTargetWid = targetWid;
    p->castTx = gx;
    p->castTz = gz;
    // ENEMY/AOE 技能：广播目标/落点位置；SELF 技能：广播施法者位置
    double castX = (sd->target == SkillTarget::SELF) ? p->pos.x : gx;
    double castZ = (sd->target == SkillTarget::SELF) ? p->pos.z : gz;
    pushEvent(proto::EVT_SKILL_CASTING, p->wid, skillId, proto::qAbs(castX), proto::qAbs(castZ));
    return true;
  }
  // 瞬发：直接结算
  resolveCast(*p, *sd, targetWid, gx, gz);
  return true;
}


// 前摇结算（统一入口：玩家/怪物/精英共用）：
// 扣蓝 + 上冷却 → EVT_SKILL 广播 → 单目标必中 + AOE 异阵营扩散 → 位移
void World::resolveCast(Entity& caster, const SkillDef& sd, uint32_t targetWid, double tx, double tz) {
  uint64_t nowMs = logicNowMs();
  // 查找主目标（用于 ENEMY 校验 + 单目标必中 + 位移方向）
  Entity* primaryTarget = (targetWid > 0) ? findByWid(targetWid) : nullptr;
  // 单目标 ENEMY 技能：结算时再次校验目标有效性，无效则不扣蓝/不上冷却（施放失败）
  if (sd.target == SkillTarget::ENEMY && targetWid > 0) {
    if (!primaryTarget || !primaryTarget->active || primaryTarget->dead) {
      if (caster.kind == EntityKind::Player) pushCastFailNotif(caster.id, sd.id, targetWid);
      return;  // 目标已死亡/消失，不消耗资源
    }
    if (sd.range > 0 && caster.pos.dist2D(primaryTarget->pos) > sd.range) {
      if (caster.kind == EntityKind::Player) pushCastFailNotif(caster.id, sd.id, targetWid);
      return;  // 目标已超出距离（结算时无容差，严格判定）
    }
  }
  if (!testFlags_.noSkillCost) {  // 测试：无消耗模式下不扣蓝、不上冷却（可连续施放）
    caster.mp -= sd.manaCost;
    caster.skillCd[sd.id] = nowMs + (uint64_t)sd.cooldownMs;
  }
  if (caster.kind == EntityKind::Player) { markStatsDirty(caster.id); markSkillsDirty(caster.id); }
  // 落点（结算时以落点为准；SELF=施法者位置）
  double gx = tx, gz = tz;
  if (sd.target == SkillTarget::SELF) { gx = caster.pos.x; gz = caster.pos.z; }
  // AOE 中心：ENEMY 技能从落点（目标位置）扩散溅射，AOE 技能从落点扩散，SELF 技能从施法者位置
  double aoeCx = (sd.target == SkillTarget::SELF) ? caster.pos.x : gx;
  double aoeCz = (sd.target == SkillTarget::SELF) ? caster.pos.z : gz;
  pushEvent(proto::EVT_SKILL, caster.wid, sd.id, proto::qAbs(gx), proto::qAbs(gz));
  const double hr = sd.radius;
  // 施加效果：统一按「施法者 vs 目标」阵营判定（kind != caster.kind = 敌方）
  switch (sd.effect) {
    case SkillEffect::DAMAGE: {
      // ① 单目标必中（targetWid 指向的实体）
      if (primaryTarget && primaryTarget->active && primaryTarget->hp > 0) {
        applySkillToTarget(caster, *primaryTarget, sd, 0.9 + rng01() * 0.2);
      }
      // ② AOE 扩散：对范围内异阵营实体施加效果（跳过施法者自身 + 主目标避免重复）
      if (sd.radius > 0) {
        for (auto& [id, e] : entities_) {
          (void)id;
          if (!e.active || e.kind == caster.kind) continue;  // 同阵营跳过
          if (primaryTarget && e.wid == primaryTarget->wid) continue;  // 主目标已受击
          if (e.pos.dist2D({aoeCx, 0, aoeCz}) > hr) continue;
          applySkillToTarget(caster, e, sd, 0.9 + rng01() * 0.2);
        }
      }
      break;
    }
    case SkillEffect::HEAL: {
      caster.hp = std::min(caster.maxHp, caster.hp + sd.heal);
      if (caster.kind == EntityKind::Player) markStatsDirty(caster.id);
      break;
    }
    case SkillEffect::BUFF: {
      if (sd.target == SkillTarget::SELF) {
        applyBuff(caster, sd.id, (uint8_t)sd.buffType, sd.buffValue, sd.buffDurSec);
      } else if (sd.radius > 0) {
        // 减益：对范围内异阵营实体施加
        for (auto& [id, e] : entities_) {
          (void)id;
          if (!e.active || e.kind == caster.kind) continue;
          if (e.pos.dist2D({aoeCx, 0, aoeCz}) > hr) continue;
          applyBuff(e, sd.id, (uint8_t)sd.buffType, sd.buffValue, sd.buffDurSec);
        }
      }
      break;
    }
    default: break;
  }
  // 位移技能：有主目标时向目标位移，否则向落点位移
  if (sd.dashDist > 0) {
    double dashTx = gx, dashTz = gz;
    if (primaryTarget && primaryTarget->active) {
      dashTx = primaryTarget->pos.x;
      dashTz = primaryTarget->pos.z;
    }
    executeDash(caster, dashTx, dashTz, sd.dashDist);
  }
}
// 位移技能：施法者沿自身→(tx,tz)方向位移 dist 米（逐步圆盘检测，撞墙即止），落回地表
// 玩家/怪物均可调用；位移由 netcode UPDATE/SNAPSHOT 自动同步，无需额外事件
void World::executeDash(Entity& caster, double tx, double tz, double dist) {
  double dx = tx - caster.pos.x, dz = tz - caster.pos.z;
  double len = std::hypot(dx, dz);
  if (len < 1e-4) { dx = 1; dz = 0; len = 1; } // 重叠时取固定方向
  const double ux = dx / len, uz = dz / len;
  const double ox = caster.pos.x, oz = caster.pos.z;
  double nx = ox, nz = oz;
  const double kStep = 0.1;
  const int steps = (int)std::ceil(dist / kStep);
  for (int i = 1; i <= steps; i++) {
    const double d = std::min(dist, kStep * (double)i);
    const double cx = ox + ux * d, cz = oz + uz * d;
    if (collision_.circleBlocked(cx, cz, caster.radius)) break;
    nx = cx; nz = cz;
  }
  caster.pos.x = nx;
  caster.pos.z = nz;
  caster.pos.y = groundFootY(nx, nz, caster.radius);
  // 玩家位移后需主动通知客户端预测器校正，否则客户端不知道位移发生
  if (caster.kind == EntityKind::Player) caster.dashPending = true;
}
// 打断施放：reason=0 被替换 / 1 移动 / 2 受击（受 castCancelOnHit 约束）；广播 EVT_SKILL_CANCEL
void World::cancelCast(Entity& e, uint8_t reason) {
  if (e.castingSkillId == 0) return;
  if (reason == 2) {
    const SkillDef* sd = data_.skill(e.castingSkillId);
    if (sd && !sd->castCancelOnHit) return; // 该技能不允许受击打断
  }
  uint32_t skillId = e.castingSkillId;
  e.castingSkillId = 0;
  e.castStartMs = 0;
  e.castTargetWid = 0;
  e.castTx = e.castTz = 0;
  if (reason != 0) pushEvent(proto::EVT_SKILL_CANCEL, e.wid, skillId, reason, 0); // 被替换不打取消事件
}
// 实体受击：施放中的玩家且技能允许 → 打断（普攻/技能/Boss AOE 共用入口）
void World::cancelCastOnHit(Entity& e) {
  if (e.castingSkillId == 0 || e.kind != EntityKind::Player) return;
  cancelCast(e, 2);
}
// 通用技能效果施加：伤害计算 + 仇恨 + 死亡 + 吸血 + 附带减益 + 击退（玩家→怪物、怪物→玩家 均可用）
void World::applySkillToTarget(Entity& caster, Entity& target, const SkillDef& sd, double variance) {
  // 无敌免疫：恢复态怪物免疫所有伤害/减益/击退
  if (target.ai.invincible) return;
  double dmg = calcDamage(caster.attack * sd.dmgMul, target.defense, variance) + sd.flatDmg;
  target.hp -= dmg;
  target.aggro[caster.wid] += dmg;
  if (target.kind == EntityKind::Monster) target.ai.chaseTime = 0; // 被攻击时重置追击计时
  pushEvent(proto::EVT_DAMAGE, target.wid, (uint32_t)dmg, 0, 0);
  // 荆棘反伤（目标有 THORNS 时反弹）
  thornsReflect(target, caster, dmg);
  // 吸血（治疗施法者）
  if (sd.lifesteal > 0) {
    caster.hp = std::min(caster.maxHp, caster.hp + dmg * sd.lifesteal);
    if (caster.kind == EntityKind::Player) markStatsDirty(caster.id);
  }
  // 附带减益（减速/流血/减防/减攻/眩晕等，按 BuffType 配置）
  if (sd.buffType != BuffType::NONE && sd.buffDurSec > 0 && target.active) {
    applyBuff(target, sd.id, (uint8_t)sd.buffType, sd.buffValue, sd.buffDurSec);
  }
  // 击退：沿 caster→target 方向位移（霸体免疫）
  if (sd.knockback > 0 && target.active) {
    applyKnockback(caster, target, sd.knockback);
  }
  if (target.hp <= 0 && target.active) {
    uint64_t nowMs = logicNowMs();
    if (target.kind == EntityKind::Player) {
      killPlayer(target, &caster);  // 玩家死亡：标记 + 复活计时 + EVT_DEATH
    } else {
      onVictimDeath(target, caster, nowMs);  // 怪物/精英死亡
    }
  }
}
// 击退：沿 from→target 水平方向把 target 位移最多 dist 米（撞墙即止），落回地表；霸体免疫；触发受击打断
void World::applyKnockback(Entity& from, Entity& target, double dist) {
  if (target.hasBuff((uint8_t)BuffType::SUPER_ARMOR)) return; // 霸体免疫击退
  if (target.ai.invincible) return; // 无敌免疫击退（恢复态）
  double dx = target.pos.x - from.pos.x, dz = target.pos.z - from.pos.z;
  double len = std::hypot(dx, dz);
  if (len < 1e-4) { dx = 1; dz = 0; len = 1; } // 重叠时取固定方向
  const double ux = dx / len, uz = dz / len;
  // 逐步推进 + 圆盘碰撞检测：击退落点必须可通行。旧实现直接整段位移且不查碰撞，
  // 可把实体（含玩家）推入不可通行区 → 破坏「服务端权威位置恒严格可通行」不变式：
  // 玩家后续每次上报都判 terrain_blocked，且 AntiCheat::clampToWalkable 因锚点自身
  // 阻挡而放弃夹紧，退化为反复软失败（玩家原地卡死）。
  // 每 0.1m 探测一次，撞到阻挡就停在上一步 —— 天然实现「撞墙即止」。
  const double ox = target.pos.x, oz = target.pos.z;
  double nx = ox, nz = oz;
  const double kStep = 0.1;
  const int steps = (int)std::ceil(dist / kStep);
  for (int i = 1; i <= steps; i++) {
    const double d = std::min(dist, kStep * (double)i);
    const double cx = ox + ux * d, cz = oz + uz * d;
    if (collision_.circleBlocked(cx, cz, target.radius)) break;
    nx = cx; nz = cz;
  }
  target.pos.x = nx;
  target.pos.z = nz;
  target.pos.y = groundFootY(nx, nz, target.radius); // 落回地表（与其他贴地点同一语义）
  cancelCastOnHit(target); // 击退视为受击：打断目标前摇（霸体技能 castCancelOnHit=false 不受影响）
  // 位移由 netcode 的 UPDATE/SNAPSHOT 帧自动同步给视野内玩家，无需额外事件
}
// 挂载 Buff：同技能同类型刷新；不同类型并存
void World::applyBuff(Entity& e, uint32_t skillId, uint8_t type, double value, double durSec) {
  if (durSec <= 0) return;
  // 霸体免疫控制：目标有 SUPER_ARMOR 时，眩晕/减速等控制类减益不生效
  if (type == (uint8_t)BuffType::STUN && e.hasBuff((uint8_t)BuffType::SUPER_ARMOR)) return;
  for (auto& b : e.buffs) {
    if (b.skillId == skillId && b.type == type) {  // 刷新
      b.value = value;
      b.remainSec = durSec;
      b.durationSec = durSec;
      if (e.kind == EntityKind::Player) { markBuffsDirty(e.id); markStatsDirty(e.id); }
      return;
    }
  }
  e.buffs.push_back({skillId, type, value, durSec, durSec});
  if (e.kind == EntityKind::Player) { markBuffsDirty(e.id); markStatsDirty(e.id); }
  // 属性类 Buff 立即生效（含减防/减攻等负值）
  if (type == (uint8_t)BuffType::ATK || type == (uint8_t)BuffType::DEF ||
      type == (uint8_t)BuffType::DEF_DOWN || type == (uint8_t)BuffType::ATK_DOWN) {
    recomputeStats(e);
  }
}
void World::removeBuffType(Entity& e, uint8_t type) {
  bool changed = false;
  for (auto it = e.buffs.begin(); it != e.buffs.end();) {
    if (it->type == type) { it = e.buffs.erase(it); changed = true; }
    else ++it;
  }
  if (changed && e.kind == EntityKind::Player) {
    recomputeStats(e);
    markBuffsDirty(e.id);
    markStatsDirty(e.id);
  }
}
// 玩家死亡统一处理（服务端权威）：hp=0 + 死亡标记 + 复活计时 + EVT_DEATH 广播。
// 复活由 playerRespawnSystem 处理。普攻/技能/Boss AOE/荆棘反伤共用。
void World::killPlayer(Entity& p, Entity* killer) {
  if (p.kind != EntityKind::Player || p.dead) return;
  uint64_t nowMs = logicNowMs();
  p.hp = 0;
  p.dead = true;
  p.respawnAtMs = nowMs + (uint64_t)(cfg_.playerRespawnSec * 1000.0);
  // 停止施放与移动意图
  cancelCast(p, 3);
  p.input.targetVX = p.input.targetVZ = 0;
  // 清仇恨：所有怪物不再锁定死亡玩家
  for (auto& [id, e] : entities_) {
    (void)id;
    e.aggro.erase(p.wid);
  }
  pushEvent(proto::EVT_DEATH, p.wid, killer ? killer->wid : 0, 0, 0);
  markStatsDirty(p.id);
}
// 荆棘反伤：victim 有 THORNS 时按比例反弹给 attacker
double World::thornsReflect(Entity& victim, Entity& attacker, double dmg) {
  for (const auto& b : victim.buffs) {
    if (b.type == (uint8_t)BuffType::THORNS && b.remainSec > 0 && dmg > 0) {
      double reflect = dmg * b.value;
      if (attacker.hp > 0) {
        attacker.hp -= reflect;
        if (attacker.kind == EntityKind::Player) markStatsDirty(attacker.id);
        pushEvent(proto::EVT_DAMAGE, attacker.wid, (uint32_t)reflect, 0, 0);
        cancelCastOnHit(attacker);  // 反伤视为受击：打断施法者前摇
        if (attacker.hp <= 0 && attacker.kind == EntityKind::Player) {
          killPlayer(attacker, &victim);
        }
      }
      return reflect;
    }
  }
  return 0;
}
// 已学技能 + 剩余冷却（S2C_SKILLS）
std::string World::skillsFrame(const Entity& p) {
  uint64_t nowMs = logicNowMs();
  proto::Writer w;
  w.u16((uint16_t)p.learnedSkills.size());
  for (uint32_t id : p.learnedSkills) {
    uint64_t ready = 0;
    auto it = p.skillCd.find(id);
    if (it != p.skillCd.end() && it->second > nowMs) ready = it->second - nowMs;
    w.u32(id);
    w.u32((uint32_t)ready);
  }
  return proto::frame(proto::S2C_SKILLS, w.data());
}
// 自身 Buff（S2C_BUFFS）
std::string World::buffsFrame(const Entity& p) {
  proto::Writer w;
  w.u16((uint16_t)p.buffs.size());
  for (const auto& b : p.buffs) {
    w.u32(b.skillId);
    w.u8(b.type);
    w.f32((float)b.value);
    w.f32((float)b.remainSec);
  }
  return proto::frame(proto::S2C_BUFFS, w.data());
}
void World::markSkillsDirty(const std::string& playerId) { skillsDirty_.insert(playerId); }
void World::markBuffsDirty(const std::string& playerId) { buffsDirty_.insert(playerId); }
// ---------- 控制台/调试辅助（GameConsole 与 /api/debug 复用） ----------
Entity* World::spawnMonster(const std::string& type, double x, double z) {
  const MonsterDef* def = data_.monster(type);
  if (!def) return nullptr;
  // 水面上自动找最近的干地
  double sx = x, sz = z;
  bool found = false;
  for (double r = 0; r <= 40 && !found; r += 3) {
    for (int k = 0; k < 16; k++) {
      double a = (double)k / 16.0 * 6.28318;
      double px = x + std::cos(a) * r, pz = z + std::sin(a) * r;
      if (!terrainBlocked(px, pz) && terrainHeight(px, pz) > kWaterLevel + 1.0) { sx = px; sz = pz; found = true; break; }
    }
  }
  Entity m = makeMonster(nextEntityId("m"), type);
  applyMonsterStats(m, type);
  m.pos = {sx, groundFootY(sx, sz, m.radius), sz};
  m.ai.homeX = sx;
  m.ai.homeZ = sz;
  m.active = true;
  m.hp = m.maxHp;
  std::string id = m.id;
  addEntity(std::move(m));
  return findEntity(id);
}
bool World::teleportPlayer(const std::string& playerId, double x, double z) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  p->pos.x = x;
  p->pos.z = z;
  p->pos.y = groundFootY(x, z, p->radius);
  p->vel = {0, 0, 0};
  p->grounded = true;
  // 防作弊重置：传送属管理/调试工具，避免在途输入被轨迹校验误判
  p->violations = 0;
  p->terrainRejects = 0;
  p->acceptedInputs = 0;
  p->rateDrops = 0;
  p->lastSeq = 0;
  return true;
}
bool World::killEntity(const std::string& playerId, uint32_t wid) {
  Entity* killer = findEntity(playerId);
  Entity* t = findByWid(wid);
  if (!t || !t->active || t->kind != EntityKind::Monster) return false;
  uint64_t nowMs = logicNowMs();
  onVictimDeath(*t, killer ? *killer : *t, nowMs);
  return true;
}
bool World::respawnEntity(const std::string& id) {
  Entity* e = findEntity(id);
  if (!e) return false;
  if (e->kind == EntityKind::Monster && !e->active) {
    e->hp = e->maxHp;
    e->mp = e->maxMp;
    e->active = true;
    e->respawnAtMs = 0;
    e->buffs.clear();
    e->pos = {e->ai.homeX, groundFootY(e->ai.homeX, e->ai.homeZ, e->radius), e->ai.homeZ};
    pushEvent(proto::EVT_RESPAWN, e->wid, 0, 0, 0);
    return true;
  }
  return false;
}
void World::respawnAllMonsters() {
  for (auto& [id, e] : entitiesMut()) {
    if (e.kind != EntityKind::Monster) continue;
    if (e.active) continue;   // 存活不动
    respawnEntity(id);
  }
}
bool World::giveItem(const std::string& playerId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  if (!data_.item(itemId) || count == 0) return false;
  giveItemSmart(*p, itemId, count);
  markInvDirty(playerId);
  markStatsDirty(playerId);
  // 任务钩子：发放物品后检测收集任务进度
  quests_->onItemAcquired(*p, itemId, count);
  return true;
}
// ---- 装备实例化辅助（阶段 0 地基）----
// 为玩家创建一件装备实例并入背包（返回 instId；itemId 非装备返回 0）
uint64_t World::giveEquipInstance(Entity& p, uint32_t itemId, uint8_t enhance) {
  const ItemDef* def = data_.item(itemId);
  if (!def || def->type != ItemType::EQUIP) return 0;
  ItemInstance ins;
  ins.instId = allocInstId();
  ins.itemId = itemId;
  ins.enhance = enhance;
  p.pl.equipBag.push_back(ins);
  return ins.instId;
}
// 智能发放：装备→新建实例入 equipBag（count 件）；其余→堆叠入 inventory
void World::giveItemSmart(Entity& p, uint32_t itemId, uint16_t count) {
  const ItemDef* def = data_.item(itemId);
  if (!def) return;
  if (def->type == ItemType::EQUIP) {
    for (uint16_t i = 0; i < count; i++) giveEquipInstance(p, itemId, 0);
  } else {
    p.pl.inventory[itemId] += count;
  }
}
// 在 equip + equipBag 中按 instId 查找装备实例
ItemInstance* World::findInstance(Entity& p, uint64_t instId) {
  if (instId == 0) return nullptr;
  for (auto& ins : p.pl.equip) if (ins.instId == instId) return &ins;
  for (auto& ins : p.pl.equipBag) if (ins.instId == instId) return &ins;
  return nullptr;
}
// 启动时从世界数据 KV 恢复实例 ID 水位（保证跨重启已存档 instId 不被重用）
void World::loadInstIdCounter() {
  if (!store_) return;
  std::string v;
  if (store_->loadWorldData("instIdCounter", v) && !v.empty()) {
    uint64_t n = (uint64_t)strtoull(v.c_str(), nullptr, 10);
    if (n > nextInstId_) nextInstId_ = n;   // 存储值为「下一个可分配」，直接抬升
    fprintf(stderr, "[items] 装备实例 ID 计数器恢复：next=%llu\n", (unsigned long long)nextInstId_);
  }
}
// 玩家存档时回写当前水位（仅数据库持久模式）
void World::saveInstIdCounter() {
  if (!store_ || !store_->worldDataPersistent()) return;
  store_->saveWorldData("instIdCounter", std::to_string(nextInstId_));
}
bool World::giveGold(const std::string& playerId, int64_t amount) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  int64_t v = (int64_t)p->pl.gold + amount;
  p->pl.gold = (uint32_t)std::max<int64_t>(0, v);
  markInvDirty(playerId);
  markStatsDirty(playerId);
  return true;
}
void World::markInvDirty(const std::string& playerId) { invDirty_.insert(playerId); }
void World::spawnDropAt(double x, double z, uint32_t itemId, uint32_t gold) {
  // 自动落到最近干地
  double sx = x, sz = z;
  bool found = false;
  for (double r = 0; r <= 30 && !found; r += 3) {
    for (int k = 0; k < 16; k++) {
      double a = (double)k / 16.0 * 6.28318;
      double px = x + std::cos(a) * r, pz = z + std::sin(a) * r;
      if (!terrainBlocked(px, pz) && terrainHeight(px, pz) > kWaterLevel + 1.0) { sx = px; sz = pz; found = true; break; }
    }
  }
  // 装备→实例掉落（分配 instId）；其余→普通掉落
  const ItemDef* it = itemId ? data_.item(itemId) : nullptr;
  if (it && it->type == ItemType::EQUIP) {
    ItemInstance ins;
    ins.instId = allocInstId();
    ins.itemId = itemId;
    spawnDropInst(sx, sz, ins);
  } else {
    spawnDrop(sx, sz, itemId, gold);
  }
}
Json World::entitiesStatus(double px, double pz, double range, int limit) const {
  Json arr = Json::array();
  int n = 0;
  for (const auto& [id, e] : entities_) {
    if (limit > 0 && n >= limit) break;
    if (!e.active) continue;
    if (range > 0 && e.pos.dist2D({px, 0, pz}) > range) continue;
    Json j = Json::object();
    j["id"] = id;
    j["wid"] = (int64_t)e.wid;
    j["kind"] = (int64_t)(int)e.kind;
    j["name"] = e.name.empty() ? e.username : e.name;
    j["hp"] = e.hp;
    j["maxHp"] = e.maxHp;
    j["atk"] = e.attack;
    j["def"] = e.defense;
    j["x"] = e.pos.x;
    j["z"] = e.pos.z;
    arr.push_back(std::move(j));
    n++;
  }
  return arr;
}
// ---------- 物品/属性/商店/掉落 实现 ----------
void World::applyMonsterStats(Entity& m, const std::string& type) {
  const MonsterDef* def = data_.monster(type);
  if (!def) return;
  m.monsterType = type;
  m.name = def->name;
  m.level = def->level;
  m.hp = m.maxHp = def->hp;
  m.mp = m.maxMp = def->mp;
  m.attack = def->attack;
  m.defense = def->defense;
  m.radius = def->radius;
  m.ai.speed = def->moveSpeed;
  m.ai.chaseSpeed = def->chaseSpeed;
  m.ai.aggroRange = def->aggroRange;
  m.ai.attackRange = def->attackRange;
  m.skillIds = def->skillIds;
  m.isElite = def->isElite;
}
// 怪物死亡掉落：金币 + 概率表物品（掉落物生成在世界，可拾取）
void World::rollDrops(Entity& killer, Entity& victim) {
  (void)killer;
  const MonsterDef* def = data_.monster(victim.monsterType);
  // 金币
  uint32_t gold = 0;
  if (def) {
    if (def->goldMax > def->goldMin) gold = def->goldMin + (uint32_t)(rng01() * (double)(def->goldMax - def->goldMin));
    else gold = def->goldMin;
  } else {
    gold = 1 + (uint32_t)(rng01() * 3.0);
  }
  if (gold > 0) spawnDrop(victim.pos.x, victim.pos.z, 0, gold);
  // 物品概率表
  if (def) {
    for (const auto& de : def->drops) {
      if (rng01() < de.prob) {
        const ItemDef* it = data_.item(de.itemId);
        if (it && it->type == ItemType::EQUIP) {
          // 装备→实例掉落（分配 instId，强化等级 0）
          ItemInstance ins;
          ins.instId = allocInstId();
          ins.itemId = de.itemId;
          ins.enhance = 0;
          spawnDropInst(victim.pos.x, victim.pos.z, ins);
        } else {
          spawnDrop(victim.pos.x, victim.pos.z, de.itemId, 0);
        }
      }
    }
  }
}
// 生成地面掉落物（itemId=0 表示纯金币）
void World::spawnDrop(double x, double z, uint32_t itemId, uint32_t gold) {
  double angle = rng01() * 6.28318;
  double dist = 0.5 + rng01() * 1.2;
  double dx = x + std::cos(angle) * dist;
  double dz = z + std::sin(angle) * dist;
  double y = terrainHeight(dx, dz) + 0.35;
  Entity d = makeDrop(nextEntityId("drop"), dx, y, dz, itemId, gold);
  d.dropExpireAtMs = logicNowMs() + (uint64_t)(cfg_.dropLifetimeSec * 1000.0);
  if (itemId) {
    const ItemDef* it = data_.item(itemId);
    d.name = it ? it->name : ("物品#" + std::to_string(itemId));
  } else {
    d.name = "金币";
  }
  addEntity(std::move(d));
  pushEvent(proto::EVT_DROP, (uint32_t)d.wid, itemId, (int32_t)gold, 0);
}
// 生成装备实例掉落（保留强化等级；dropItemId 同步为 itemId 供客户端展示）
void World::spawnDropInst(double x, double z, const ItemInstance& inst) {
  double angle = rng01() * 6.28318;
  double dist = 0.5 + rng01() * 1.2;
  double dx = x + std::cos(angle) * dist;
  double dz = z + std::sin(angle) * dist;
  double y = terrainHeight(dx, dz) + 0.35;
  Entity d = makeDrop(nextEntityId("drop"), dx, y, dz, inst.itemId, 0, inst);
  d.dropExpireAtMs = logicNowMs() + (uint64_t)(cfg_.dropLifetimeSec * 1000.0);
  const ItemDef* it = data_.item(inst.itemId);
  d.name = it ? it->name : ("物品#" + std::to_string(inst.itemId));
  addEntity(std::move(d));
  pushEvent(proto::EVT_DROP, (uint32_t)d.wid, inst.itemId, 0, 0);
}
// 移除地面掉落物
void World::despawnEntity(const std::string& id) {
  auto it = entities_.find(id);
  if (it == entities_.end()) return;
  widToId_.erase(it->second.wid);
  aoi_.remove(it->second.wid);
  chunks_.removeEntity(it->second);
  entities_.erase(id);
}
// 移除地面掉落物
void World::despawnDrop(const std::string& id) { despawnEntity(id); }
// 拾取地面掉落物
bool World::playerPickup(const std::string& playerId, uint32_t dropWid) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  Entity* d = findByWid(dropWid);
  if (!d || d->kind != EntityKind::Item || !d->active) return false;
  if (p->pos.dist2D(d->pos) > cfg_.pickupRangeM) return false;
  // 转移（金币是物品，都进背包/钱包）
  if (d->dropGold > 0) p->pl.gold += d->dropGold;
  if (d->dropInst.instId != 0) {
    // 装备实例：直接入背包（保留 instId + 强化等级）
    p->pl.equipBag.push_back(d->dropInst);
    quests_->onItemAcquired(*p, d->dropInst.itemId, 1);
  } else if (d->dropItemId > 0) {
    p->pl.inventory[d->dropItemId] += 1;
    // 任务钩子：拾取物品后检测收集任务进度
    quests_->onItemAcquired(*p, d->dropItemId, 1);
  }
  despawnDrop(d->id);
  return true;
}
// 穿戴/卸下装备（slot 槽位值 1..6；instId=0 卸下）——装备实例化
bool World::equipItem(const std::string& playerId, uint8_t slot, uint64_t instId) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  int idx;
  if (!GameData::slotIndex((EquipSlot)slot, idx)) return false;
  if (instId == 0) {
    // 卸下：已穿戴实例移回背包
    if (p->pl.equip[idx].instId != 0) {
      p->pl.equipBag.push_back(p->pl.equip[idx]);
      p->pl.equip[idx] = ItemInstance{};
      recomputeStats(*p);
      return true;
    }
    return false;
  }
  // 在背包中查找该实例
  int bagIdx = -1;
  for (int i = 0; i < (int)p->pl.equipBag.size(); i++)
    if (p->pl.equipBag[i].instId == instId) { bagIdx = i; break; }
  if (bagIdx < 0) return false;   // 不在背包（已穿戴/不存在）
  const ItemDef* def = data_.item(p->pl.equipBag[bagIdx].itemId);
  if (!def || def->type != ItemType::EQUIP) return false;
  if (def->slot != (EquipSlot)slot) return false;
  if (def->levelReq > p->level) return false;  // 需求等级不足，不可装备
  // 交换：新实例上身，旧实例（如有）回背包
  ItemInstance newIns = p->pl.equipBag[bagIdx];
  p->pl.equipBag.erase(p->pl.equipBag.begin() + bagIdx);
  if (p->pl.equip[idx].instId != 0) p->pl.equipBag.push_back(p->pl.equip[idx]);
  p->pl.equip[idx] = newIns;
  recomputeStats(*p);
  return true;
}
// 使用消耗品（恢复血量/蓝量）
bool World::useItem(const std::string& playerId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  const ItemDef* def = data_.item(itemId);
  if (!def || def->type != ItemType::CONSUMABLE) return false;
  auto inv = p->pl.inventory.find(itemId);
  if (inv == p->pl.inventory.end()) return false;
  uint16_t use = count < 1 ? 1 : count;
  use = (uint16_t)std::min((uint32_t)use, inv->second);
  bool changed = false;
  for (uint16_t i = 0; i < use; i++) {
    bool any = false;
    if (def->restoreHp > 0 && p->hp < p->maxHp) { p->hp = std::min(p->maxHp, p->hp + def->restoreHp); any = true; }
    if (def->restoreMp > 0 && p->mp < p->maxMp) { p->mp = std::min(p->maxMp, p->mp + def->restoreMp); any = true; }
    if (!any) break; // 满血满蓝不再消耗
    changed = true;
    inv->second -= 1;
    if (inv->second == 0) { p->pl.inventory.erase(itemId); break; }
  }
  if (!changed) return false;
  return true;
}
// 打开商店：校验与商店 NPC 距离
bool World::openShop(const std::string& playerId, uint32_t npcWid) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  Entity* npc = findByWid(npcWid);
  if (!npc || npc->kind != EntityKind::Npc || npc->shopId == 0) return false;
  if (p->pos.dist2D(npc->pos) > cfg_.shopOpenRangeM) return false;
  p->pl.openShopId = npc->shopId;
  refreshShopLimits(*p);   // 打开面板前结算到期的每日/每周限购重置，确保 bought 计数为最新
  return true;
}
// ---- 商店限购/回收辅助（阶段1）----
// 限购计数 key：高 32 位 shopId + 低 32 位 itemId
static inline uint64_t shopKey(uint32_t shopId, uint32_t itemId) {
  return ((uint64_t)shopId << 32) | (uint64_t)itemId;
}
// 默认回收率：商店未显式配置 sellPrice 时，按 ItemDef.price × 此比例回收
static constexpr double kShopSellRate = 0.5;

// 购买物品（金币扣减 + 进背包；需商店已打开；阶段1：限购/折扣/刷新）
bool World::buyItem(const std::string& playerId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  if (p->pl.openShopId == 0) return false;
  const ShopDef* shop = data_.shop(p->pl.openShopId);
  if (!shop) { p->pl.openShopId = 0; return false; }
  // 找商品（价格/库存/限购）
  const ShopEntry* entry = nullptr;
  for (const auto& e : shop->entries) if (e.itemId == itemId) { entry = &e; break; }
  if (!entry) return false;
  const ItemDef* def = data_.item(itemId);
  if (!def) return false;
  uint16_t n = count < 1 ? 1 : count;
  // 限购周期刷新（每日/每周）：先结算到期重置，再校验本次购买
  refreshShopLimits(*p);
  // 限购校验（buyLimit>0 才限；按玩家累计）
  if (entry->buyLimit > 0) {
    uint32_t bought = p->pl.shopBuyCount[shopKey(p->pl.openShopId, itemId)];
    if (bought + n > entry->buyLimit) {
      fprintf(stderr, "[shop] 限购拒绝：玩家 %s 物品 %u 已购 %u 上限 %u 本次 %u\n",
              playerId.c_str(), itemId, bought, entry->buyLimit, (unsigned)n);
      return false;
    }
  }
  // 折扣价优先（discountPrice>0 时用折扣价结算）
  uint32_t unit = entry->discountPrice > 0 ? entry->discountPrice : entry->price;
  uint64_t cost = (uint64_t)unit * n;
  if (cost > p->pl.gold) return false; // 金币不足
  if (entry->stock > 0 && entry->stock < n) return false; // 库存不足
  p->pl.gold -= (uint32_t)cost;
  giveItemSmart(*p, itemId, n);   // 装备→实例入背包；其余→堆叠
  // 累计限购计数（仅 buyLimit>0 的条目追踪）
  if (entry->buyLimit > 0) p->pl.shopBuyCount[shopKey(p->pl.openShopId, itemId)] += n;
  // 更新库存（stock>0 才扣减）
  // 注：ShopDef 为配置表，动态库存需独立维护；当前 stock=0 无限量，此处保留扩展位。
  return true;
}

// 商店限购周期刷新：按 logicNowMs 计算跨越的整天数，重置到期条目的购买计数。
// 每日条目(refreshType=1)每天重置；每周条目(refreshType=2)满 7 天重置。
// shopRefreshMs 按整天推进（保留不足一天的余数），确保每周计时不被每日刷新清零。
void World::refreshShopLimits(Entity& p) {
  const uint64_t DAY = 86400000ULL;
  uint64_t now = logicNowMs();
  if (p.pl.shopRefreshMs == 0) { p.pl.shopRefreshMs = now; return; } // 首次建立基准
  if (now <= p.pl.shopRefreshMs) return;
  uint64_t days = (now - p.pl.shopRefreshMs) / DAY;
  if (days == 0) return;
  bool weekly = days >= 7;
  for (auto it = p.pl.shopBuyCount.begin(); it != p.pl.shopBuyCount.end(); ) {
    uint32_t shopId = (uint32_t)(it->first >> 32);
    uint32_t itemId = (uint32_t)(it->first & 0xFFFFFFFFULL);
    uint8_t rt = entryRefreshType(shopId, itemId);
    if (rt == 1 || (rt == 2 && weekly)) it = p.pl.shopBuyCount.erase(it);
    else ++it;
  }
  p.pl.shopRefreshMs += days * DAY;
}

uint8_t World::entryRefreshType(uint32_t shopId, uint32_t itemId) const {
  const ShopDef* shop = data_.shop(shopId);
  if (shop) for (const auto& e : shop->entries) if (e.itemId == itemId) return e.refreshType;
  return 0;
}

uint32_t World::calcSellPrice(uint32_t shopId, uint32_t itemId) const {
  const ShopDef* shop = data_.shop(shopId);
  if (shop) for (const auto& e : shop->entries) if (e.itemId == itemId && e.sellPrice > 0) return e.sellPrice;
  const ItemDef* def = data_.item(itemId);
  if (!def) return 0;
  return (uint32_t)(def->price * kShopSellRate);
}

// 出售回收：装备实例（仅背包装备，锁定/已穿戴不可卖）或堆叠物品。
// 回收价：商店 sellPrice 优先，否则 ItemDef.price×默认回收率；装备再乘强化系数。
// 返回获得金币（0=失败：未在商店/无此物/锁定/无回收价）。
uint32_t World::sellItem(const std::string& playerId, bool isInstance, uint64_t instId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return 0;
  if (p->pl.openShopId == 0) return 0;  // 需在商店（与 buyItem 一致）
  uint32_t gain = 0;
  if (isInstance) {
    // 装备实例：仅背包(equipBag)可出售，已穿戴需先卸下；锁定不可出售
    ItemInstance* ins = nullptr;
    for (auto& e : p->pl.equipBag) if (e.instId == instId) { ins = &e; break; }
    if (!ins || ins->locked) return 0;
    uint32_t base = calcSellPrice(p->pl.openShopId, ins->itemId);
    if (base == 0) return 0;  // 无回收价，不可出售
    double enhanceMul = 1.0 + ins->enhance * 0.5;  // 强化系数（阶段2接入 EnhanceConfig；enhance=0 时=1）
    gain = (uint32_t)(base * enhanceMul);
    for (size_t i = 0; i < p->pl.equipBag.size(); i++)
      if (p->pl.equipBag[i].instId == instId) { p->pl.equipBag.erase(p->pl.equipBag.begin() + (ptrdiff_t)i); break; }
  } else {
    auto it = p->pl.inventory.find(itemId);
    if (it == p->pl.inventory.end() || it->second == 0) return 0;
    uint32_t unit = calcSellPrice(p->pl.openShopId, itemId);
    if (unit == 0) return 0;
    uint16_t n = count < 1 ? 1 : count;
    if (it->second < n) n = (uint16_t)it->second;  // 持有不足则卖现有数量
    gain = unit * n;
    it->second -= n;
    if (it->second == 0) p->pl.inventory.erase(it);
  }
  p->pl.gold += gain;
  fprintf(stderr, "[shop] 出售回收：玩家 %s %s 获得 %u 金（余额 %u）\n",
          playerId.c_str(), isInstance ? "装备" : "物品", gain, p->pl.gold);
  return gain;
}
// 重算派生属性：基础属性 + 装备加成
void World::recomputeStats(Entity& p) {
  double maxHp = p.pl.baseHp, maxMp = p.pl.baseMp, atk = p.pl.baseAttack, def = p.pl.baseDefense;
  const EnhanceConfig& ec = economy_->enhance().config();   // 强化系数表
  for (int i = 0; i < kEquipSlots; i++) {
    const ItemInstance& ins = p.pl.equip[i];
    if (!ins.instId) continue;
    const ItemDef* it = data_.item(ins.itemId);
    if (!it) continue;
    // 强化加成（阶段2）：装备基础加成 ×(1 + enhance × 每级系数)；蓝量不参与强化
    double e = (double)ins.enhance;
    maxHp += it->hpBonus * (1.0 + e * ec.attrPerLevelHp);
    maxMp += it->mpBonus;
    atk += it->attackBonus * (1.0 + e * ec.attrPerLevelAtk);
    def += it->defenseBonus * (1.0 + e * ec.attrPerLevelDef);
  }
  // 属性类 Buff（攻/防加成 + 减防/减攻等负值）叠加
  for (const auto& b : p.buffs) {
    if (b.type == (uint8_t)BuffType::ATK || b.type == (uint8_t)BuffType::ATK_DOWN) atk += b.value;
    else if (b.type == (uint8_t)BuffType::DEF || b.type == (uint8_t)BuffType::DEF_DOWN) def += b.value;
  }
  if (atk < 1) atk = 1;       // 攻击下限保护（防减攻出现负攻击）
  if (maxHp < 1) maxHp = 1;
  if (maxMp < 0) maxMp = 0;
  p.maxHp = maxHp;
  p.maxMp = maxMp;
  p.attack = atk;
  p.defense = def;
  if (p.hp > p.maxHp) p.hp = p.maxHp;
  if (p.mp > p.maxMp) p.mp = p.maxMp;
}
// 附近是否存在带指定标签的 NPC（服务端权威距离校验，防客户端伪造交互）
bool World::nearNpcWithTag(const Entity& p, uint32_t tag, double range) const {
  for (const auto& kv : entities_) {
    const Entity& e = kv.second;
    if (e.kind != EntityKind::Npc) continue;
    if ((e.npcTag & tag) == 0) continue;
    if (p.pos.dist2D(e.pos) <= range) return true;
  }
  return false;
}
// 装备强化（阶段2）：铁匠邻近校验 → doEnhance（金币/强化石/保护符）→ 重算属性 + 标记脏
EnhanceResult World::enhanceEquip(const std::string& playerId, uint64_t instId, bool useProtect) {
  EnhanceResult r;
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) { r.failCode = 7; return r; }
  r.goldLeft = p->pl.gold;
  // 铁匠邻近校验（BLACKSMITH 标签 + 交互距离内；复用商店交互半径）
  if (!nearNpcWithTag(*p, NPC_TAG_BLACKSMITH, cfg_.shopOpenRangeM)) { r.failCode = 6; return r; }
  // 定位装备实例（穿戴中或背包）
  ItemInstance* ins = findInstance(*p, instId);
  if (!ins) { r.failCode = 7; return r; }
  // 执行强化（testFlags_.enhanceForce 供测试确定性旁路：0 正常 / 1 强制成功 / 2 强制失败）
  r = economy_->enhance().doEnhance(*ins, p->pl.gold, p->pl.inventory, rng_, useProtect, testFlags_.enhanceForce);
  if (r.ok) {
    recomputeStats(*p);          // 强化改变装备加成 → 重算派生属性
    markStatsDirty(playerId);
    markInvDirty(playerId);      // 金币/材料/装备 enhance 变化 → 补发背包与属性
  }
  return r;
}
// 装备分解（阶段3）：铁匠邻近校验 → 已穿戴/锁定拒绝 → doDecompose（材料/金币/强化石）→ 移除实例
DecomposeOutput World::decomposeEquip(const std::string& playerId, uint64_t instId) {
  DecomposeOutput out;
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) { out.failCode = 2; return out; }
  // 铁匠邻近校验（BLACKSMITH 标签 + 交互距离内；复用商店交互半径）
  if (!nearNpcWithTag(*p, NPC_TAG_BLACKSMITH, cfg_.shopOpenRangeM)) { out.failCode = 6; return out; }
  // 已穿戴装备需先卸下（equip 槽位内命中即视为穿戴中）
  for (const auto& ins : p->pl.equip)
    if (ins.instId == instId) { out.failCode = 4; return out; }
  // 定位背包中的装备实例
  ItemInstance* ins = nullptr;
  size_t bagIdx = 0;
  for (size_t i = 0; i < p->pl.equipBag.size(); i++)
    if (p->pl.equipBag[i].instId == instId) { ins = &p->pl.equipBag[i]; bagIdx = i; break; }
  if (!ins) { out.failCode = 2; return out; }
  // 查 ItemDef 取品质/基础价（rarity 决定分解档位，price 决定金币返还基数）
  const ItemDef* def = data_.item(ins->itemId);
  if (!def || def->type != ItemType::EQUIP) { out.failCode = 2; return out; }
  // 执行分解（锁定拒绝在 doDecompose 内处理；产出材料/金币/强化石写入背包与金币）
  out = economy_->enhance().doDecompose(*ins, def->rarity, def->price, p->pl.gold, p->pl.inventory, rng_);
  if (out.ok) {
    uint32_t decItemId = ins->itemId;   // erase 后 ins 失效，先快照日志字段
    uint8_t decEnh = ins->enhance;
    // 移除已分解的装备实例（bagIdx 仍有效：doDecompose 不改 equipBag）
    p->pl.equipBag.erase(p->pl.equipBag.begin() + (ptrdiff_t)bagIdx);
    markInvDirty(playerId);            // 金币/材料/装备移除 → 补发背包
    fprintf(stderr, "[decompose] 玩家 %s 分解装备 inst=%llu(itemId=%u,enh=%u) → 金币+%u，产出 %zu 种\n",
            playerId.c_str(), (unsigned long long)instId, decItemId, decEnh,
            out.goldGain, out.items.size());
  }
  return out;
}
// 物品合成（阶段4）：查配方 → 合成 NPC 邻近校验（按配方 npcTag）→ doCraft（等级/材料/金币）→ 装备实例化 / 堆叠入包
CraftOutput World::craftItem(const std::string& playerId, uint32_t recipeId, uint32_t count) {
  CraftOutput out;
  out.recipeId = recipeId;
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) { out.failCode = 6; return out; }
  // 查配方（不存在直接拒绝）
  const CraftRecipe* r = economy_->craft().recipe(recipeId);
  if (!r) { out.failCode = 1; return out; }
  // 合成 NPC 邻近校验（按配方要求的标签 + 交互距离；复用商店交互半径）
  if (!nearNpcWithTag(*p, r->npcTag, cfg_.shopOpenRangeM)) { out.failCode = 6; return out; }
  // 查产物 ItemDef 判定是否装备（装备→实例产出；其余→堆叠入背包）
  const ItemDef* def = data_.item(r->resultItemId);
  if (!def) { out.failCode = 1; return out; }
  bool resultIsEquip = (def->type == ItemType::EQUIP);
  // 执行合成（等级/材料/金币校验 + 扣除在 doCraft 内；堆叠产出直接写 inv）
  out = economy_->craft().doCraft(*r, p->level, resultIsEquip, p->pl.gold, p->pl.inventory, count);
  if (out.ok) {
    if (out.isInstance) out.instId = giveEquipInstance(*p, out.resultItemId, 0);   // 装备产出：分配实例入背包
    markInvDirty(playerId);       // 金币/材料/装备变化 → 补发背包
    fprintf(stderr, "[craft] 玩家 %s 合成配方 %u → itemId=%u ×%u%s（金币-%u）\n",
            playerId.c_str(), recipeId, out.resultItemId, out.resultCount,
            out.isInstance ? "（装备实例）" : "", out.goldCost);
  }
  return out;
}
// 合成配方列表（阶段4）：按 npcWid 对应 NPC 的标签 + 玩家等级过滤，返回可用 recipeId 列表
std::vector<uint32_t> World::craftList(const std::string& playerId, uint32_t npcWid) {
  std::vector<uint32_t> ids;
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return ids;
  Entity* npc = findByWid(npcWid);
  uint32_t tagMask = 0;
  if (npc && npc->kind == EntityKind::Npc) {
    if (p->pos.dist2D(npc->pos) > cfg_.shopOpenRangeM) return ids;   // 超距：空列表
    tagMask = npc->npcTag;
  } else {
    // npcWid 无效时的防御回退：要求邻近有 CRAFT NPC
    if (!nearNpcWithTag(*p, NPC_TAG_CRAFT, cfg_.shopOpenRangeM)) return ids;
    tagMask = NPC_TAG_CRAFT;
  }
  if ((tagMask & NPC_TAG_CRAFT) == 0) return ids;   // 该 NPC 无合成能力
  for (const CraftRecipe* r : economy_->craft().availableRecipes(tagMask, p->level))
    ids.push_back(r->recipeId);
  return ids;
}
// 打开仓库（阶段5）：银行 NPC 邻近校验（BANK 标签）→ ensureInit → 返回仓库数据（nullptr=失败）
const WarehouseData* World::openWarehouse(const std::string& playerId, uint32_t npcWid) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return nullptr;
  bool near = false;
  Entity* npc = findByWid(npcWid);
  if (npc && npc->kind == EntityKind::Npc)
    near = (p->pos.dist2D(npc->pos) <= cfg_.shopOpenRangeM) && ((npc->npcTag & NPC_TAG_BANK) != 0);
  else
    near = nearNpcWithTag(*p, NPC_TAG_BANK, cfg_.shopOpenRangeM);
  if (!near) return nullptr;
  warehouse_->ensureInit(p->pl.warehouse);
  return &p->pl.warehouse;
}
// 获取玩家仓库数据（存取/扩展后下发用；无 NPC 校验，ensureInit 保证已初始化）
const WarehouseData* World::warehouseData(const std::string& playerId) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return nullptr;
  warehouse_->ensureInit(p->pl.warehouse);
  return &p->pl.warehouse;
}
// 存入物品（阶段5）：银行邻近校验 → deposit（金币/装备实例/堆叠合并）→ 标记脏
uint8_t World::depositItem(const std::string& playerId, bool isInstance, uint64_t instId, uint32_t itemId, uint32_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return WH_NO_NPC;
  if (!nearNpcWithTag(*p, NPC_TAG_BANK, cfg_.shopOpenRangeM)) return WH_NO_NPC;
  uint8_t code = warehouse_->deposit(p->pl.warehouse, p->pl.gold, isInstance, instId, itemId, count,
                                     p->pl.equipBag, p->pl.inventory);
  if (code == WH_OK) {
    markInvDirty(playerId);   // 背包/金币变化 → 补发 S2C_INVENTORY
    fprintf(stderr, "[warehouse] 玩家 %s 存入%s（inst=%llu itemId=%u count=%u）\n", playerId.c_str(),
            isInstance ? "装备" : (itemId == 0 ? "金币" : "物品"),
            (unsigned long long)instId, itemId, count);
  }
  return code;
}
// 取出物品（阶段5）：银行邻近校验 → withdraw（装备保留强化/堆叠回背包）→ 标记脏
uint8_t World::withdrawItem(const std::string& playerId, bool isInstance, uint64_t instId, uint32_t itemId, uint32_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return WH_NO_NPC;
  if (!nearNpcWithTag(*p, NPC_TAG_BANK, cfg_.shopOpenRangeM)) return WH_NO_NPC;
  uint8_t code = warehouse_->withdraw(p->pl.warehouse, p->pl.gold, isInstance, instId, itemId, count,
                                      p->pl.equipBag, p->pl.inventory);
  if (code == WH_OK) {
    markInvDirty(playerId);
    fprintf(stderr, "[warehouse] 玩家 %s 取出%s（inst=%llu itemId=%u count=%u）\n", playerId.c_str(),
            isInstance ? "装备" : (itemId == 0 ? "金币" : "物品"),
            (unsigned long long)instId, itemId, count);
  }
  return code;
}
// 扩展仓库（阶段5）：银行邻近校验 → expand（扣金币，解锁一页）→ 标记脏
uint8_t World::expandWarehouse(const std::string& playerId) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return WH_NO_NPC;
  if (!nearNpcWithTag(*p, NPC_TAG_BANK, cfg_.shopOpenRangeM)) return WH_NO_NPC;
  uint8_t code = warehouse_->expand(p->pl.warehouse, p->pl.gold);
  if (code == WH_OK) {
    markInvDirty(playerId);   // 金币变化
    fprintf(stderr, "[warehouse] 玩家 %s 扩展仓库 → %u 格\n", playerId.c_str(), p->pl.warehouse.unlocked);
  }
  return code;
}
void World::markStatsDirty(const std::string& playerId) {
  statsDirty_.insert(playerId);
}
void World::markQuestDirty(const std::string& playerId) {
  questDirty_.insert(playerId);
}

// 世界共享事件：推入本 tick 队列（netcode 每 tick 全区广播后清空）
void World::pushEvent(uint8_t type, uint32_t wid, uint32_t b, int32_t x, int32_t z) {
  sharedEvents_.push_back({type, wid, b, x, z});
}
std::vector<SharedEvent> World::takeSharedEvents() {
  auto out = std::move(sharedEvents_);
  sharedEvents_.clear();
  return out;
}
// 施放结算失败通知：推入队列（netcode 每 tick 定向发给目标玩家）
void World::pushCastFailNotif(const std::string& playerId, uint32_t skillId, uint32_t targetWid) {
  castFailNotifs_.push_back({playerId, skillId, targetWid});
}
std::vector<CastFailNotif> World::takeCastFailNotifs() {
  auto out = std::move(castFailNotifs_);
  castFailNotifs_.clear();
  return out;
}

// ---------------- 系统实现 ----------------
static void inputSystem(World& w, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.logicNowMs();
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p) continue;
    // 死亡：不移动/不脱战回血（等待复活系统处理）
    if (p->dead) {
      p->input.targetVX = p->input.targetVZ = 0;
      continue;
    }
    // 位置上报模式：玩家 targetVX/VZ 由 handleInput 从位置差分估算，此处不再计算
    // 眩晕：强制归零速度（handleInput 已拒绝位置变化，此处确保广播速度为 0）
    if (p->hasBuff((uint8_t)BuffType::STUN)) {
      p->input.targetVX = p->input.targetVZ = 0;
    }
    // 脱战回血/回蓝（5s 未受击）；整数值变化才标记脏（避免每 tick 刷 STATS 帧）
    bool statsChanged = false;
    if (p->hp > 0 && p->hp < p->maxHp && nowMs - p->lastDamageMs >= 5000) {
      double before = std::floor(p->hp);
      p->hp = std::min(p->maxHp, p->hp + cfg.playerRegenPerSec * dt);
      if (std::floor(p->hp) != before) statsChanged = true;
    }
    if (p->mp >= 0 && p->mp < p->maxMp && nowMs - p->lastDamageMs >= 5000) {
      double before = std::floor(p->mp);
      p->mp = std::min(p->maxMp, p->mp + cfg.playerMpRegenPerSec * dt);
      if (std::floor(p->mp) != before) statsChanged = true;
    }
    if (statsChanged) w.markStatsDirty(p->id);
  }
}
// 2.5D 移动：物理积分（含重力/地表高度碰撞）→ 静态地形碰撞（沿轴滑动）→ 贴地重算
// 客户端预测（predict.js）复刻同一套地形碰撞，保证预测与服务端一致
static void moveEntityCollide(World& w, Entity& e, double tx, double tz, double dt) {
  const double ox = e.pos.x, oz = e.pos.z;
  w.physics().setHorizontalVelocity(e, tx, tz, dt);
  w.physics().step(e, dt);
  // 静态地形碰撞：目标位圆盘与不可通行（湖泊/河流/悬崖/陡坡）重叠 → 沿轴滑动回退
  if (w.collision().circleBlocked(e.pos.x, e.pos.z, e.radius)) {
    w.collision().slideMove(e, ox, oz, e.pos.x, e.pos.z);
  }
  // 贴地重算（滑动后地表可能变化）
  double foot = groundFootY(e.pos.x, e.pos.z, e.radius);
  if (e.pos.y < foot) {
    e.pos.y = foot;
    e.vel.y = 0;
    e.grounded = true;
  }
}
static void moveSystem(World& w, double dt) {
  // 玩家位置由 handleInput 采纳驱动，不再经过 moveEntityCollide
  const bool paused = w.testFlags().monstersPaused;  // 测试：冻结怪物移动（仍受重力贴地，不漂移）
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || !e.active) continue;
    const double px = e.pos.x, pz = e.pos.z;
    const double tvx = paused ? 0.0 : e.ai.targetVX;
    const double tvz = paused ? 0.0 : e.ai.targetVZ;
    const bool wantsMove = (tvx != 0.0 || tvz != 0.0);
    moveEntityCollide(w, e, tvx, tvz, dt);
    // 卡住检测：有移动意图但实际位移≈０（被空洞/深水/悬崖/实体墙挡住）→ 累积；否则恢复
    if (wantsMove && std::hypot(e.pos.x - px, e.pos.z - pz) < 0.05) e.ai.stuckT += dt;
    else e.ai.stuckT = std::max(0.0, e.ai.stuckT - dt);
  }
  // 玩家碰撞分离已移除：玩家位置完全由 handleInput 采纳驱动，碰撞推挤仅在客户端渲染层生效
}
// 施放系统：推进前摇。前摇到期 → 结算；前摇期间移动意图 → 打断（大型网游标配）
static void castSystem(World& w, double dt) {
  (void)dt;
  uint64_t nowMs = w.logicNowMs();
  const bool paused = w.testFlags().monstersPaused;  // 测试：冻结怪物/Boss 前摇推进
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (!e.active || e.castingSkillId == 0) continue;
    if (paused && e.kind != EntityKind::Player) continue;  // 冻结期间怪物不结算施放
    const SkillDef* sd = w.data().skill(e.castingSkillId);
    if (!sd) { e.castingSkillId = 0; continue; }
    // 移动打断：玩家按了移动键（目标速度非零）即取消
    if (sd->castCancelOnMove &&
        (std::fabs(e.input.targetVX) > 0.01 || std::fabs(e.input.targetVZ) > 0.01)) {
      w.cancelCast(e, 1);
      continue;
    }
    // 前摇到期 → 统一结算（玩家/怪物/精英共用 resolveCast）
    if (nowMs >= e.castStartMs + (uint64_t)sd->castTimeMs) {
      uint32_t skillId = e.castingSkillId;
      uint32_t twid = e.castTargetWid;
      double tx = e.castTx, tz = e.castTz;
      e.castingSkillId = 0;
      const SkillDef* s2 = w.data().skill(skillId);
      if (s2) w.resolveCast(e, *s2, twid, tx, tz);
    }
  }
  // 位置上报模式：targetVX/VZ 由 handleInput 从位置差分估算，代表「本 tick 收到的移动意图」。
  // castSystem 消费后必须归零，否则残留速度会在后续 tick 误触发移动打断（即使玩家已停止发送输入）。
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (p) { p->input.targetVX = 0; p->input.targetVZ = 0; }
  }
}
// Buff 系统：每 tick 衰减剩余时长 + 持续效果（REGEN 回血 / BLEED 流血），过期移除并重算属性
static void buffSystem(World& w, double dt) {
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (!e.active || e.buffs.empty()) continue;
    bool expired = false;
    bool statsChanged = false;
    for (auto it = e.buffs.begin(); it != e.buffs.end();) {
      it->remainSec -= dt;
      // 持续回血（REGEN）：每秒恢复 value 点
      if (it->type == (uint8_t)BuffType::REGEN && it->remainSec > 0 && e.hp > 0) {
        double before = std::floor(e.hp);
        e.hp = std::min(e.maxHp, e.hp + it->value * dt);
        if (std::floor(e.hp) != before) statsChanged = true;
      }
      // 流血（BLEED）：每秒损失 value 点生命（DoT，不致死演示保护：最低 1 HP）
      if (it->type == (uint8_t)BuffType::BLEED && it->remainSec > 0 && e.hp > 1) {
        double before = std::floor(e.hp);
        e.hp = std::max(1.0, e.hp - it->value * dt);
        if (std::floor(e.hp) != before) {
          w.pushEvent(proto::EVT_DAMAGE, e.wid, (uint32_t)(it->value * dt), 0, 0);
          if (e.kind == EntityKind::Player) statsChanged = true;
        }
      }
      if (it->remainSec <= 0) { it = e.buffs.erase(it); expired = true; }
      else ++it;
    }
    if (expired || statsChanged) {
      // 属性类 Buff 失效/变化需重算派生属性
      w.recomputeStats(e);
      if (e.kind == EntityKind::Player) {
        w.markBuffsDirty(e.id);
        w.markStatsDirty(e.id);
      }
    }
  }
}
// 生物/NPC AI：大规模调度（AOI 激活 + 时间片轮转 + 距离分级）→ 状态机
static void aiSystem(World& w, double dt) {
  if (w.testFlags().monstersPaused) return;  // 测试：全局冻结怪物/NPC AI（站桩测试）
  const auto& cfg = w.config();
  AiScheduler sched(cfg);
  uint64_t tick = w.tickCount();
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || !e.active) continue;
    if (!sched.shouldTick(w, e, tick)) continue; // AOI 激活 + 时间片 + 距离分级
    if (e.kind == EntityKind::Monster) tickMonsterAi(w, e, dt);
    else tickNpcAi(w, e, dt);
  }
}
// 地面掉落物生命周期：超时消失（主动清理，向视野玩家发 LEAVE）
static void dropSystem(World& w, double) {
  uint64_t nowMs = w.logicNowMs();
  std::vector<std::string> expire;
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind != EntityKind::Item || !e.active) continue;
    if (nowMs >= e.dropExpireAtMs) expire.push_back(id);
  }
  for (const auto& id : expire) w.despawnDrop(id);
}

// 普通怪物死亡复活（精英与普通怪物一致）
static void respawnSystem(World& w, double) {
  uint64_t nowMs = w.logicNowMs();
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player) continue;
    if (!e.active && nowMs >= e.respawnAtMs) {
      e.hp = e.maxHp;
      e.active = true;
      e.pos.x = e.ai.homeX;
      e.pos.z = e.ai.homeZ;
      e.pos.y = groundFootY(e.pos.x, e.pos.z, e.radius);
      e.vel = {0, 0, 0};
      e.aggro.clear();
      w.pushEvent(proto::EVT_RESPAWN, e.wid, 0, 0, 0);
    }
  }
}
// 玩家复活系统：死亡计时到期 → 回安全出生点满状态复活 + EVT_RESPAWN 广播。
// 复活位置走服务器权威（World 记录待校正玩家，由网络层补发 correction+强制快照）。
static void playerRespawnSystem(World& w, double) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.logicNowMs();
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p || !p->dead || p->respawnAtMs == 0) continue;
    if (nowMs < p->respawnAtMs) continue;
    // 复活：满血满蓝
    p->dead = false;
    p->respawnAtMs = 0;
    p->hp = p->maxHp;
    p->mp = p->maxMp;
    // 找安全复活点：主城圆盘开放空地（出生点附近，无怪物、NPC 在旁）
    double sx = 0, sz = 0;
    bool found = false;
    Mulberry32 rng((uint32_t)(p->wid * 2654435761u) ^ (uint32_t)cfg.worldSeed);
    for (double r = 0; r <= kTownSpawnRadius && !found; r += 1.5) {
      for (int k = 0; k < 12 && !found; k++) {
        double a = rng.next() * 6.28318;
        double px = std::cos(a) * r, pz = std::sin(a) * r;
        if (w.collision().canStand(px, pz, p->radius)) { sx = px; sz = pz; found = true; }
      }
    }
    if (!found) { sx = 0; sz = 0; }
    p->pos.x = sx;
    p->pos.z = sz;
    p->pos.y = groundFootY(sx, sz, p->radius);
    p->vel = {0, 0, 0};
    p->grounded = true;
    p->input.targetVX = p->input.targetVZ = 0;
    // 清仇恨：其他怪物不再锁定复活后的玩家旧位置
    for (auto& [id, e] : w.entitiesMut()) {
      (void)id;
      e.aggro.erase(p->wid);
    }
    w.pushEvent(proto::EVT_RESPAWN, p->wid, 0, 0, 0);
    w.markStatsDirty(p->id);
    w.pushRespawnedPlayer(p->id);  // 网络层补发校正+强制快照（防作弊重置）
  }
}
// ---------------- tick ----------------
void World::tick() {
  double dt = cfg_.tickMs / 1000.0;
  tick_++;
  updateSystems(dt);
  // 同步实体区块归属 + AOI 网格（仅跨格时更新）
  for (auto& [id, e] : entities_) {
    (void)id;
    chunks_.updateEntityChunk(e);
    aoi_.move(e.wid, e.pos.x, e.pos.z);
  }
  // 更新各玩家加载集合
  for (const auto& pid : players_) {
    Entity* p = findEntity(pid);
    if (p) chunks_.updatePlayerChunks(*p);
  }
}
void World::updateSystems(double dt) {
  for (auto& [prio, sys] : systems_) {
    (void)prio;
    sys.second(*this, dt);
  }
}
Json World::buildSnapshot(const Entity& player) {
  auto visible = chunks_.entitiesInRange(player.pos, cfg_.viewRangeM);
  Json entities = Json::array();
  for (Entity* e : visible) entities.push_back(e->serialize());
  Json j = Json::object();
  j["type"] = "snapshot";
  j["tick"] = (int64_t)tick_;
  j["t"] = (int64_t)logicNowMs();
  j["viewRange"] = cfg_.viewRangeM;
  j["count"] = (int64_t)entities.size();
  j["entities"] = entities;
  return j;
}
} // namespace ew
