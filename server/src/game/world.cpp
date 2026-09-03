// world.cpp - 世界管理器实现 + 世界怪物/世界Boss 状态共享（服务端单点权威）
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
// 世界 Boss 固定锚点（确定性，可调）
// 世界 Boss 锚点：远离城镇/出生点安全区（>=40m），且位于可通行地图区域（用与地形 mask 一致的采样选定）
// 默认系统（前向声明，定义在文件后部）
static void inputSystem(World& w, double dt);
static void moveSystem(World& w, double dt);
static void aiSystem(World& w, double dt);
static void castSystem(World& w, double dt);
static void buffSystem(World& w, double dt);
static void bossSystem(World& w, double dt);
static void respawnSystem(World& w, double dt);
static void playerRespawnSystem(World& w, double dt);
static void dropSystem(World& w, double dt);
World::World(const Config& cfg)
    : cfg_(cfg), physics_(cfg), chunks_(*this, cfg),
      aoi_(cfg.aoiCellSizeM), rng_((uint32_t)cfg.worldSeed ^ 0x51ab) {
  // 出生点布局不再硬编码：由世界初始化执行器（runWorldInit）数据驱动生成，
  // 或数据库模式从库还原（loadWorldFromStore）。构造时不填充默认布局。
  // 初始化社交系统
  friends_ = std::make_unique<FriendSystem>(*this);
  guilds_ = std::make_unique<GuildSystem>(*this);
  chat_ = std::make_unique<ChatSystem>(*this);
  quests_ = std::make_unique<QuestSystem>(*this);
  addSystem(10, "input", inputSystem);
  addSystem(20, "move", moveSystem);
  addSystem(30, "ai", aiSystem);
  addSystem(32, "cast", castSystem);
  addSystem(35, "buff", buffSystem);
  addSystem(40, "boss", bossSystem);
  addSystem(50, "respawn", respawnSystem);
  addSystem(55, "player_respawn", playerRespawnSystem);
  addSystem(60, "drop", dropSystem);
  // 配置系统：内置默认数据 + 可选 JSON 覆盖（data/items.json / monsters.json / shop.json）
  data_.loadDefaults();
  data_.loadFromJson(cfg.dataDir);
  // 任务系统：内置默认任务 + 可选 JSON 覆盖
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
void World::spawnBossAt(double hx, double hz, const std::string& name) {
  Entity b = makeMonster(nextEntityId("boss"), "gargoyle");
  b.isBoss = true;
  b.radius = 1.4;
  b.hp = b.maxHp = cfg_.bossHp;
  b.mp = b.maxMp = cfg_.bossMp;
  b.attack = cfg_.bossAttack;
  b.defense = cfg_.bossDefense;
  b.level = 60;
  b.name = name.empty() ? "荒原巨兽" : name;
  // 在锚点附近找干地出生
  double bx = hx, bz = hz;
  bool found = false;
  for (double r = 0; r <= 80 && !found; r += 4) {
    for (int k = 0; k < 24; k++) {
      double a = (double)k / 24.0 * 6.28318;
      double px = hx + std::cos(a) * r, pz = hz + std::sin(a) * r;
      if (!terrainBlocked(px, pz) && terrainHeight(px, pz) > kWaterLevel + 1.0) { bx = px; bz = pz; found = true; break; }
    }
  }
  b.pos = {bx, terrainHeight(bx, bz) + b.radius + 0.3, bz};
  b.ai.homeX = bx;
  b.ai.homeZ = bz;
  b.skillIds = {2100, 2101};  // Boss 技能：地裂冲击 / 暗影波动
  addEntity(std::move(b));
  aliveBoss_++;
}
// 按出生点生成一只生物（monster/npc/boss）
void World::spawnFromPoint(const SpawnPoint& sp) {
  if (sp.kind == SP_MONSTER) {
    // 相同怪物成群：群内围绕锚点小半径散布（确定性），避免完全重叠；
    // spawnMonster 会在附近自动寻找可通行干地，保证不落空洞/水中。
    const std::string type = sp.type.empty() ? "wolf" : sp.type;
    int n = sp.count > 0 ? sp.count : 1;
    for (int i = 0; i < n; i++) {
      double ang = (double)i / (double)n * 6.283185307;
      double rr = (i == 0) ? 0.0 : 2.0 + (double)(i % 3) * 1.6;   // 0 / 2.0 / 3.6 / 5.2 米内散布
      spawnMonster(type, sp.x + std::cos(ang) * rr, sp.z + std::sin(ang) * rr);
    }
  } else if (sp.kind == SP_NPC) {
    spawnNpcAt(sp);
  } else if (sp.kind == SP_BOSS) {
    spawnBossAt(sp.x, sp.z, sp.name);
  }
}
// 按出生点生成一个城镇 NPC：就近找干地，可带商店/名称
void World::spawnNpcAt(const SpawnPoint& sp) {
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
  n.pos = {sx, terrainHeight(sx, sz) + n.radius + 0.3, sz};
  n.ai.homeX = n.pos.x;
  n.ai.homeZ = n.pos.z;
  if (sp.shopId) { n.shopId = sp.shopId; n.ai.aiState = 0; } // 守店不游走
  if (!sp.name.empty()) n.name = sp.name;
  if (sp.shopId) {
    fprintf(stderr, "[shopnpc] spawn id=%s pos=(%.2f,%.2f,%.2f) home=(%.2f,%.2f)\n",
            n.id.c_str(), n.pos.x, n.pos.y, n.pos.z, n.ai.homeX, n.ai.homeZ);
  }
  addEntity(std::move(n));
}
// 热重载：清空现有种子生物（m_*/n_*/boss_*）并按当前出生点配置重建
void World::reseedCreatures() {
  std::vector<std::string> toRemove;
  for (const auto& [id, e] : entities_) {
    if (e.kind == EntityKind::Player) continue;
    if (id.rfind("m_", 0) == 0 || id.rfind("n_", 0) == 0 || id.rfind("boss_", 0) == 0)
      toRemove.push_back(id);
  }
  for (const auto& id : toRemove) despawnEntity(id);
  aliveBoss_ = 0;
  seedWorld();
  fprintf(stderr, "[spawns] 热重载完成：%zu 个出生点 → 重建世界生物\n", spawns_.size());
}
// 应用新出生点配置：fromJson → 持久化 data/spawns.json → 热重载世界生物
bool World::applySpawns(const std::string& json, const std::string& dataDir) {
  if (!spawns_.fromJson(json)) return false;
  spawns_.saveFile(dataDir + "/spawns.json");
  // 数据库模式：同步将出生点（连同当前 mask）落库，保证重启后一致
  if (store_ && store_->worldDataPersistent()) saveWorldToStore(*store_);
  reseedCreatures();
  return true;
}
// 应用编辑器物品配置：热替换内存 items_ → 持久化 data/items.json（物品为查询型，无需重建实体）
bool World::applyItems(const std::string& itemsJson, const std::string& dataDir) {
  try {
    Json arr = Json::parse(itemsJson);
    if (!data_.replaceItems(arr)) return false;
  } catch (...) { return false; }
  data_.saveItemsFile(dataDir + "/items.json");
  fprintf(stderr, "[gamedata] 物品配置热重载：%zu 件\n", data_.items().size());
  return true;
}
// 应用编辑器生物配置：热替换内存 monsters_ → 持久化 data/monsters.json → 热重载世界生物
bool World::applyMonsters(const std::string& monstersJson, const std::string& dataDir) {
  try {
    Json obj = Json::parse(monstersJson);
    if (!data_.replaceMonsters(obj)) return false;
  } catch (...) { return false; }
  data_.saveMonstersFile(dataDir + "/monsters.json");
  reseedCreatures();
  fprintf(stderr, "[gamedata] 生物配置热重载：%zu 种\n", data_.monsters().size());
  return true;
}
Entity* World::spawnPlayer(const std::string& username, Vec3* spawnHint) {
  Entity p = makePlayer(nextEntityId("p"), username);
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
    p.pos = {x, terrainHeight(x, z) + p.radius + 0.3, z};
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
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
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
  pushEvent(proto::EVT_DAMAGE, t->wid, (uint32_t)dmg, 0, 0);
  if (t->isBoss) markBossDirty();
  // 荆棘反伤：目标（怪物/Boss）若有 THORNS Buff，反弹部分伤害给攻击者
  thornsReflect(*t, *p, dmg);
  if (t->hp <= 0) onVictimDeath(*t, *p, nowMs);
  // 任务钩子：击杀怪物后检测任务进度
  quests_->onMonsterKill(*p, t->monsterType);
  return true;
}
// 目标死亡统一处理（普攻/技能共用）：Boss 复活 / 普通怪物失活+复活 + 掉落
void World::onVictimDeath(Entity& victim, Entity& killer, uint64_t nowMs) {
  victim.hp = 0;
  // 击杀奖励经验（仅玩家击杀者）：怪物按 expReward，Boss 无类型配置时兜底
  if (killer.kind == EntityKind::Player) {
    const MonsterDef* kdef = victim.monsterType.empty() ? nullptr : data_.monster(victim.monsterType);
    uint32_t exp = kdef ? kdef->expReward : (victim.isBoss ? 500u : 0u);
    if (exp) grantExp(killer, exp);
  }
  if (victim.isBoss) {
    victim.bossState = BS_DEAD;
    victim.bossTarget = 0;
    victim.respawnAtMs = nowMs + (uint64_t)(cfg_.bossRespawnSec * 1000.0);
    victim.aggro.clear();
    victim.buffs.clear();
    victim.vel = {0, 0, 0};
    if (aliveBoss_ > 0) aliveBoss_--;
    pushEvent(proto::EVT_DEATH, victim.wid, killer.wid, 0, 0);
    markBossDirty();
    rollDrops(killer, victim);
  } else {
    // 普通怪物死亡：失活 + 本区复活计时 + 掉落
    rollDrops(killer, victim);
    victim.active = false;
    victim.respawnAtMs = nowMs + (uint64_t)(cfg_.monsterRespawnSec * 1000.0);
    victim.aggro.clear();
    victim.buffs.clear();
    victim.vel = {0, 0, 0};
    pushEvent(proto::EVT_DEATH, victim.wid, killer.wid, 0, 0);
  }
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
// 施放技能：校验（已学/冷却/耗蓝/目标/距离）→ 扣蓝+冷却 → 施加效果 → 广播
// 开始施放技能（两阶段：前摇 → 结算）。返回是否成功开始施放。
//  - castTimeMs==0：瞬发，直接结算（扣蓝/冷却/效果）
//  - castTimeMs>0 ：进入前摇（castingSkillId 置位 + 广播 EVT_SKILL_CASTING），
//                  由 castSystem 到期后 resolveCast；移动/受击打断（cancelCast）
bool World::beginCast(const std::string& playerId, uint32_t skillId, uint32_t targetWid, double tx, double tz) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player || p->dead) return false;  // 死亡不可施放
  const SkillDef* sd = data_.skill(skillId);
  if (!sd) return false;
  if (!p->learnedSkills.count(skillId)) return false;  // 未学习
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
  const bool freeCast = testFlags_.noSkillCost;  // 测试：无冷却/无蓝耗，便于重复施放同一技能
  auto cdit = p->skillCd.find(skillId);
  if (!freeCast && cdit != p->skillCd.end() && cdit->second > nowMs) return false;  // 冷却中
  if (!freeCast && p->mp < sd->manaCost) return false;  // 蓝量不足
  // 取消目标检测：无目标（targetWid=0）也可施放。命中全部按「落点 + radius」范围计算。
  // 落点语义：SELF=自身位置；ENEMY/AOE=客户端指定落点（用于范围命中判定）。
  double gx = tx, gz = tz;
  if (sd->target == SkillTarget::SELF) { gx = p->pos.x; gz = p->pos.z; }
  else if (sd->range > 0 && p->pos.dist2D({gx, 0, gz}) > sd->range) {
    return false; // 施法距离（落点距施法者）——仍作基础约束，防止超距施法
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
    pushEvent(proto::EVT_SKILL_CASTING, p->wid, skillId, proto::qAbs(gx), proto::qAbs(gz));
    return true;
  }
  // 瞬发：直接结算
  resolveCast(*p, *sd, targetWid, gx, gz);
  return true;
}
// 命中半径：radius>0 用 radius，radius==0 视为近战贴身范围（1.2m）——所有技能统一按此判定
static double hitRadius(const SkillDef& sd) { return sd.radius > 0 ? sd.radius : 1.2; }

// 前摇结算：扣蓝 + 上冷却（仅结算时消耗，前摇被打断不扣）→ EVT_SKILL 广播 → 按范围施加效果
void World::resolveCast(Entity& caster, const SkillDef& sd, uint32_t targetWid, double tx, double tz) {
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
  if (!testFlags_.noSkillCost) {  // 测试：无消耗模式下不扣蓝、不上冷却（可连续施放）
    caster.mp -= sd.manaCost;
    caster.skillCd[sd.id] = nowMs + (uint64_t)sd.cooldownMs;
  }
  if (caster.kind == EntityKind::Player) { markStatsDirty(caster.id); markSkillsDirty(caster.id); }
  // 落点（结算时以落点为准；SELF=施法者位置）
  double gx = tx, gz = tz;
  if (sd.target == SkillTarget::SELF) { gx = caster.pos.x; gz = caster.pos.z; }
  pushEvent(proto::EVT_SKILL, caster.wid, sd.id, proto::qAbs(gx), proto::qAbs(gz));
  const double hr = hitRadius(sd);
  // 施加效果：全部按「落点 + 命中半径」计算是否击中（无目标检测）
  switch (sd.effect) {
    case SkillEffect::DAMAGE: {
      for (auto& [id, e] : entities_) {
        (void)id;
        if (!e.active || e.kind != EntityKind::Monster) continue;
        if (e.pos.dist2D({gx, 0, gz}) > hr) continue;  // 范围命中
        applySkillToTarget(caster, e, sd, 0.9 + rng01() * 0.2);
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
      } else {
        // 减益按范围命中（对怪物）
        for (auto& [id, e] : entities_) {
          (void)id;
          if (!e.active || e.kind != EntityKind::Monster) continue;
          if (e.pos.dist2D({gx, 0, gz}) > hr) continue;
          applyBuff(e, sd.id, (uint8_t)sd.buffType, sd.buffValue, sd.buffDurSec);
        }
      }
      break;
    }
    default: break;
  }
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
  double dmg = calcDamage(caster.attack * sd.dmgMul, target.defense, variance) + sd.flatDmg;
  target.hp -= dmg;
  target.aggro[caster.wid] += dmg;
  pushEvent(proto::EVT_DAMAGE, target.wid, (uint32_t)dmg, 0, 0);
  if (target.isBoss) markBossDirty();
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
    uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
    onVictimDeath(target, caster, nowMs);
  }
}
// 击退：沿 from→target 水平方向把 target 位移 dist 米，落回地形高度；霸体免疫；触发受击打断
void World::applyKnockback(Entity& from, Entity& target, double dist) {
  if (target.hasBuff((uint8_t)BuffType::SUPER_ARMOR)) return; // 霸体免疫击退
  double dx = target.pos.x - from.pos.x, dz = target.pos.z - from.pos.z;
  double len = std::hypot(dx, dz);
  if (len < 1e-4) { dx = 1; dz = 0; len = 1; } // 重叠时取固定方向
  target.pos.x += dx / len * dist;
  target.pos.z += dz / len * dist;
  target.pos.y = terrainHeight(target.pos.x, target.pos.z); // 落回地表
  if (target.isBoss) markBossDirty();
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
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
  p.hp = 0;
  p.dead = true;
  p.respawnAtMs = nowMs + (uint64_t)(cfg_.playerRespawnSec * 1000.0);
  // 停止施放与移动意图
  cancelCast(p, 3);
  p.input.targetVX = p.input.targetVZ = 0;
  p.input.moveX = p.input.moveZ = 0;
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
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
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
  m.pos = {sx, terrainHeight(sx, sz) + m.radius + 0.3, sz};
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
  p->pos.y = terrainHeight(x, z) + p->radius + 0.3;
  p->vel = {0, 0, 0};
  p->grounded = true;
  // 防作弊重置：传送属管理/调试工具，避免在途输入被轨迹校验误判
  p->violations = 0;
  p->acceptedInputs = 0;
  p->rateDrops = 0;
  p->lastSeq = 0;
  return true;
}
bool World::killEntity(const std::string& playerId, uint32_t wid) {
  Entity* killer = findEntity(playerId);
  Entity* t = findByWid(wid);
  if (!t || !t->active || t->kind != EntityKind::Monster) return false;
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
  onVictimDeath(*t, killer ? *killer : *t, nowMs);
  return true;
}
bool World::respawnEntity(const std::string& id) {
  Entity* e = findEntity(id);
  if (!e) return false;
  if (e->isBoss) {
    e->hp = e->maxHp;
    e->mp = e->maxMp;
    e->bossState = BS_IDLE;
    e->bossTarget = 0;
    e->bossPhase = 1;
    e->aggro.clear();
    e->buffs.clear();
    e->active = true;
    e->respawnAtMs = 0;
    aliveBoss_++;
    pushEvent(proto::EVT_RESPAWN, e->wid, 0, 0, 0);
    markBossDirty();
    return true;
  }
  if (e->kind == EntityKind::Monster && !e->active) {
    e->hp = e->maxHp;
    e->mp = e->maxMp;
    e->active = true;
    e->respawnAtMs = 0;
    e->buffs.clear();
    e->pos = {e->ai.homeX, terrainHeight(e->ai.homeX, e->ai.homeZ) + e->radius + 0.3, e->ai.homeZ};
    pushEvent(proto::EVT_RESPAWN, e->wid, 0, 0, 0);
    return true;
  }
  return false;
}
void World::respawnAllMonsters() {
  for (auto& [id, e] : entitiesMut()) {
    if (e.kind != EntityKind::Monster) continue;
    if (e.isBoss && e.active) continue;   // 存活 Boss 不动
    respawnEntity(id);
  }
}
bool World::giveItem(const std::string& playerId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  if (!data_.item(itemId) || count == 0) return false;
  p->pl.inventory[itemId] += count;
  markInvDirty(playerId);
  markStatsDirty(playerId);
  // 任务钩子：发放物品后检测收集任务进度
  quests_->onItemAcquired(*p, itemId, count);
  return true;
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
  spawnDrop(sx, sz, itemId, gold);
}
Json World::bossesStatus() const {
  Json arr = Json::array();
  for (const auto& [id, e] : entities_) {
    if (!e.isBoss) continue;
    Json j = Json::object();
    j["name"] = e.name;
    j["wid"] = (int64_t)e.wid;
    j["state"] = (int64_t)e.bossState;
    j["phase"] = (int64_t)e.bossPhase;
    j["hp"] = e.hp;
    j["maxHp"] = e.maxHp;
    j["active"] = e.active;
    j["x"] = e.pos.x;
    j["z"] = e.pos.z;
    arr.push_back(std::move(j));
  }
  return arr;
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
  m.ai.speed = def->moveSpeed;  // 移动速度（AI 巡逻/追击用）
  m.skillIds = def->skillIds;
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
        spawnDrop(victim.pos.x, victim.pos.z, de.itemId, 0);
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
  d.dropExpireAtMs = tick_ * (uint64_t)cfg_.tickMs + (uint64_t)(cfg_.dropLifetimeSec * 1000.0);
  if (itemId) {
    const ItemDef* it = data_.item(itemId);
    d.name = it ? it->name : ("物品#" + std::to_string(itemId));
  } else {
    d.name = "金币";
  }
  addEntity(std::move(d));
  pushEvent(proto::EVT_DROP, (uint32_t)d.wid, itemId, (int32_t)gold, 0);
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
  if (d->dropItemId > 0) {
    p->pl.inventory[d->dropItemId] += 1;
    // 任务钩子：拾取物品后检测收集任务进度
    quests_->onItemAcquired(*p, d->dropItemId, 1);
  }
  despawnDrop(d->id);
  return true;
}
// 穿戴/卸下装备（slot 槽位值 1..6；itemId=0 卸下）
bool World::equipItem(const std::string& playerId, uint8_t slot, uint32_t itemId) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  int idx;
  if (!GameData::slotIndex((EquipSlot)slot, idx)) return false;
  if (itemId == 0) {
    // 卸下
    if (p->pl.equip[idx] != 0) {
      p->pl.equip[idx] = 0;
      recomputeStats(*p);
      return true;
    }
    return false;
  }
  const ItemDef* def = data_.item(itemId);
  if (!def || def->type != ItemType::EQUIP) return false;
  if (def->slot != (EquipSlot)slot) return false;
  if (def->levelReq > p->level) return false;  // 需求等级不足，不可装备
  // 需拥有该物品
  auto inv = p->pl.inventory.find(itemId);
  if (inv == p->pl.inventory.end() || inv->second < 1) return false;
  // 身上已有装备：替换（旧装备回背包）
  uint32_t old = p->pl.equip[idx];
  if (old == itemId) return false;
  if (old) p->pl.inventory[old] += 1;
  p->pl.inventory[itemId] -= 1;
  if (p->pl.inventory[itemId] == 0) p->pl.inventory.erase(itemId);
  p->pl.equip[idx] = itemId;
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
  return true;
}
// 购买物品（金币扣减 + 进背包；需商店已打开）
bool World::buyItem(const std::string& playerId, uint32_t itemId, uint16_t count) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  if (p->pl.openShopId == 0) return false;
  const ShopDef* shop = data_.shop(p->pl.openShopId);
  if (!shop) { p->pl.openShopId = 0; return false; }
  // 找商品（价格/库存）
  const ShopEntry* entry = nullptr;
  for (const auto& e : shop->entries) if (e.itemId == itemId) { entry = &e; break; }
  if (!entry) return false;
  const ItemDef* def = data_.item(itemId);
  if (!def) return false;
  uint16_t n = count < 1 ? 1 : count;
  uint64_t cost = (uint64_t)entry->price * n;
  if (cost > p->pl.gold) return false; // 金币不足
  if (entry->stock > 0 && entry->stock < n) return false; // 库存不足
  p->pl.gold -= (uint32_t)cost;
  p->pl.inventory[itemId] += n;
  // 更新库存（stock>0 才扣减）
  // 注：ShopDef 为配置表，动态库存需独立维护；当前 stock=0 无限量，此处保留扩展位。
  return true;
}
// 重算派生属性：基础属性 + 装备加成
void World::recomputeStats(Entity& p) {
  double maxHp = p.pl.baseHp, maxMp = p.pl.baseMp, atk = p.pl.baseAttack, def = p.pl.baseDefense;
  for (int i = 0; i < kEquipSlots; i++) {
    uint32_t id = p.pl.equip[i];
    if (!id) continue;
    const ItemDef* it = data_.item(id);
    if (!it) continue;
    maxHp += it->hpBonus;
    maxMp += it->mpBonus;
    atk += it->attackBonus;
    def += it->defenseBonus;
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
// 世界 Boss 全局共享状态帧（dirty 去重；force 用于 HELLO 加入即一致）
std::string World::bossFrame(bool force) {
  if (!force && !bossDirty_) return "";
  bossDirty_ = false;
  std::string out;
  for (auto& [id, e] : entities_) {
    (void)id;
    if (e.isBoss && e.active) out += proto::bossState(e);
  }
  return out;
}
std::vector<const Entity*> World::bosses() const {
  std::vector<const Entity*> out;
  for (auto& [id, e] : entities_) {
    (void)id;
    if (e.isBoss) out.push_back(&e);
  }
  return out;
}
// ---------------- 系统实现 ----------------
static void inputSystem(World& w, double dt) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p) continue;
    // 死亡：不移动/不跳跃/不脱战回血（等待复活系统处理）
    if (p->dead) {
      p->input.targetVX = p->input.targetVZ = 0;
      p->input.moveX = p->input.moveZ = 0;
      continue;
    }
    // 眩晕：无法移动/跳跃（控制状态；霸体可免疫 STUN 挂载）
    const bool stunned = p->hasBuff((uint8_t)BuffType::STUN);
    // 加速 Buff：比例加成（SPEED>0），与减速叠加
    double spdMul = 1.0;
    for (const auto& b : p->buffs) {
      if (b.type == (uint8_t)BuffType::SPEED) spdMul += b.value;
      else if (b.type == (uint8_t)BuffType::MOVE_SLOW) spdMul -= b.value;
    }
    if (spdMul < 0.05) spdMul = 0.05;
    double speed = cfg.maxMoveSpeed * spdMul;
    double mx = stunned ? 0 : p->input.moveX;
    double mz = stunned ? 0 : p->input.moveZ;
    double len = std::hypot(mx, mz);
    double tx = 0, tz = 0;
    if (len > 1e-4) {
      tx = (mx / len) * speed;
      tz = (mz / len) * speed;
    }
    p->input.targetVX = tx;
    p->input.targetVZ = tz;
    if (p->input.jump && !stunned) {
      p->input.jump = false;
      w.physics().tryJump(*p);
    } else if (p->input.jump) {
      p->input.jump = false;
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
  double gy = terrainHeight(e.pos.x, e.pos.z);
  double foot = gy + e.radius;
  if (e.pos.y < foot) {
    e.pos.y = foot;
    e.vel.y = 0;
    e.grounded = true;
  }
}
static void moveSystem(World& w, double dt) {
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p || p->dead) continue;  // 死亡玩家静止（等待复活）
    moveEntityCollide(w, *p, p->input.targetVX, p->input.targetVZ, dt);
    // 任务钩子：移动后检测到达目标
    w.quests().onPlayerMove(*p);
  }
  const bool paused = w.testFlags().monstersPaused;  // 测试：冻结怪物移动（仍受重力贴地，不漂移）
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || !e.active) continue;
    const double px = e.pos.x, pz = e.pos.z;
    const double tvx = paused ? 0.0 : e.ai.targetVX;
    const double tvz = paused ? 0.0 : e.ai.targetVZ;
    const bool wantsMove = (tvx != 0.0 || tvz != 0.0);
    moveEntityCollide(w, e, tvx, tvz, dt);
    // 卡住检测：有移动意图但实际位移≈0（被空洞/深水/悬崖/实体墙挡住）→ 累积；否则恢复
    if (wantsMove && std::hypot(e.pos.x - px, e.pos.z - pz) < 0.05) e.ai.stuckT += dt;
    else e.ai.stuckT = std::max(0.0, e.ai.stuckT - dt);
  }
  // 实体-实体碰撞（2.5D 圆形分离）：动态实体（玩家/怪物/Boss/NPC）不可互相穿透，
  // 重叠时沿连线各推开一半；推开后若落入障碍则回退（避免把实体挤进水里/悬崖）。
  std::vector<std::string> dyn;
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Item || !e.active || e.dead) continue;
    dyn.push_back(id);
  }
  for (const auto& id : dyn) {
    Entity* a = w.findEntity(id);
    if (!a) continue;
    auto near = w.aoi().inRange(a->pos.x, a->pos.z, 4.0);
    for (uint32_t wid : near) {
      if (wid == a->wid) continue;
      Entity* b = w.findByWid(wid);
      if (!b || b->kind == EntityKind::Item || !b->active || b->dead) continue;
      if (b->wid < a->wid) continue;  // 每对只处理一次
      const double ax = a->pos.x, az = a->pos.z, bx = b->pos.x, bz = b->pos.z;
      const bool aPlayer = a->kind == EntityKind::Player;
      const bool bPlayer = b->kind == EntityKind::Player;
      if (Collision::separate(*a, *b)) {
        // 玩家永不被实体推挤（怪物/Boss/NPC 让行）：玩家轨迹仅由地形碰撞决定，
        // 客户端预测可完全复刻，不被动态阻挡破坏预测一致性。
        if (aPlayer) { a->pos.x = ax; a->pos.z = az; }
        if (bPlayer) { b->pos.x = bx; b->pos.z = bz; }
        if (!aPlayer && w.collision().circleBlocked(a->pos.x, a->pos.z, a->radius)) { a->pos.x = ax; a->pos.z = az; }
        if (!bPlayer && w.collision().circleBlocked(b->pos.x, b->pos.z, b->radius)) { b->pos.x = bx; b->pos.z = bz; }
      }
    }
  }
}
// 施放系统：推进前摇。前摇到期 → 结算；前摇期间移动意图 → 打断（大型网游标配）
static void castSystem(World& w, double dt) {
  (void)dt;
  uint64_t nowMs = w.tickCount() * (uint64_t)w.config().tickMs;
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
    // 前摇到期 → 结算
    if (nowMs >= e.castStartMs + (uint64_t)sd->castTimeMs) {
      uint32_t skillId = e.castingSkillId;
      uint32_t twid = e.castTargetWid;
      double tx = e.castTx, tz = e.castTz;
      e.castingSkillId = 0;
      const SkillDef* s2 = w.data().skill(skillId);
      if (s2) w.resolveCast(e, *s2, twid, tx, tz);
    }
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
    if (e.isBoss) continue; // Boss 走 bossSystem（全局，不走 LOD）
    if (!sched.shouldTick(w, e, tick)) continue; // AOI 激活 + 时间片 + 距离分级
    if (e.kind == EntityKind::Monster) tickMonsterAi(w, e, dt);
    else tickNpcAi(w, e, dt);
  }
}
// 地面掉落物生命周期：超时消失（主动清理，向视野玩家发 LEAVE）
static void dropSystem(World& w, double) {
  uint64_t nowMs = w.tickCount() * (uint64_t)w.config().tickMs;
  std::vector<std::string> expire;
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind != EntityKind::Item || !e.active) continue;
    if (nowMs >= e.dropExpireAtMs) expire.push_back(id);
  }
  for (const auto& id : expire) w.despawnDrop(id);
}

// 世界 Boss 状态机：全区共享（Idle 回血/侦测 → Engage 追击/普攻/范围技能 → Dead 复活计时）
static void bossSystem(World& w, double dt) {
  if (w.testFlags().monstersPaused) return;  // 测试：全局冻结 Boss AI（站桩测试）
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (!e.isBoss || !e.active) continue;
    tickBossAi(w, e, dt); // Boss 仅 3 只，每 tick 全量（全局共享状态需确定性推进）
  }
}
// 普通怪物死亡复活
static void respawnSystem(World& w, double) {
  const auto& cfg = w.config();
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || e.isBoss) continue;
    if (!e.active && nowMs >= e.respawnAtMs) {
      e.hp = e.maxHp;
      e.active = true;
      e.pos.x = e.ai.homeX;
      e.pos.z = e.ai.homeZ;
      e.pos.y = terrainHeight(e.pos.x, e.pos.z) + e.radius + 0.3;
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
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
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
    p->pos.y = terrainHeight(sx, sz) + p->radius + 0.3;
    p->vel = {0, 0, 0};
    p->grounded = true;
    p->input.targetVX = p->input.targetVZ = 0;
    p->input.moveX = p->input.moveZ = 0;
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
  j["t"] = (int64_t)(tick_ * cfg_.tickMs);
  j["viewRange"] = cfg_.viewRangeM;
  j["count"] = (int64_t)entities.size();
  j["entities"] = entities;
  return j;
}
} // namespace ew
