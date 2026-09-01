// world.cpp - 世界管理器实现 + 世界怪物/世界Boss 状态共享（服务端单点权威）
#include "world.h"
#include "terrain.h"
#include <cstdio>
#include "ai.h"
#include "net/protocol.h"
#include <algorithm>
#include <cmath>
namespace ew {
// 简易随机源（AI 用；单线程）
static Mulberry32 gAiRng(0xC0FFEE);
static double rng01() { return gAiRng.next(); }
// 世界 Boss 固定锚点（确定性，可调）
static const std::vector<std::pair<double, double>> kBossAnchors = {
  {0, 0}, {160, -120}, {-170, 150},
};
// 位置哈希 → 怪物类型（确定性：复活后类型不变）
static const char* monsterTypeAt(double x, double z);
// 默认系统（前向声明，定义在文件后部）
static void inputSystem(World& w, double dt);
static void moveSystem(World& w, double dt);
static void aiSystem(World& w, double dt);
static void bossSystem(World& w, double dt);
static void respawnSystem(World& w, double dt);
static void dropSystem(World& w, double dt);
World::World(const Config& cfg)
    : cfg_(cfg), physics_(cfg), chunks_(*this, cfg),
      aoi_(cfg.aoiCellSizeM), rng_((uint32_t)cfg.worldSeed ^ 0x51ab) {
  addSystem(10, "input", inputSystem);
  addSystem(20, "move", moveSystem);
  addSystem(30, "ai", aiSystem);
  addSystem(40, "boss", bossSystem);
  addSystem(50, "respawn", respawnSystem);
  addSystem(60, "drop", dropSystem);
  // 配置系统：内置默认数据 + 可选 JSON 覆盖（data/items.json / monsters.json / shop.json）
  data_.loadDefaults();
  data_.loadFromJson(cfg.dataDir);
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
  for (int i = 0; i < cfg_.monsterCount; i++) {
    double x, y, z;
    randomSpawn(rng_, x, y, z);
    // 按位置哈希稳定分配怪物类型（4 种：野狼/哥布林/骷髅/石像鬼）
    const char* type = monsterTypeAt(x, z);
    Entity m = makeMonster(nextEntityId("m"), type);
    applyMonsterStats(m, type);
    m.pos = {x, terrainHeight(x, z) + m.radius + 0.3, z};
    m.ai.homeX = m.pos.x;
    m.ai.homeZ = m.pos.z;
    addEntity(std::move(m));
  }
  for (int i = 0; i < cfg_.npcCount; i++) {
    Entity n = makeNpc(nextEntityId("n"));
    double x, y, z;
    randomSpawn(rng_, x, y, z);
    n.pos = {x, terrainHeight(x, z) + n.radius + 0.3, z};
    n.ai.homeX = n.pos.x;
    n.ai.homeZ = n.pos.z;
    if (i == 0) {
      // 商店 NPC：就近固定锚点（世界中央，便于测试），出售全部物品
      n.shopId = 1;
      n.name = "商店老板·全能杂货铺";
      n.pos = {6.0, terrainHeight(6.0, 6.0) + n.radius + 0.3, 6.0};
      n.ai.homeX = n.pos.x;
      n.ai.homeZ = n.pos.z;
      n.ai.aiState = 0; // IDLE 不游走（守店）
      fprintf(stderr, "[shopnpc] spawn id=%s pos=(%.2f,%.2f,%.2f) home=(%.2f,%.2f)\n",
              n.id.c_str(), n.pos.x, n.pos.y, n.pos.z, n.ai.homeX, n.ai.homeZ);
    }
    addEntity(std::move(n));
  }
  // 世界 Boss：全区共享实体（全局模拟 + Zone 广播）
  int bossN = std::min(cfg_.bossCount, (int)kBossAnchors.size());
  for (int i = 0; i < bossN; i++) {
    spawnBoss(i, kBossAnchors[i].first, kBossAnchors[i].second);
  }
}
void World::spawnBoss(int idx, double hx, double hz) {
  Entity b = makeMonster(nextEntityId("boss"), "gargoyle");
  b.isBoss = true;
  b.radius = 1.4;
  b.hp = b.maxHp = cfg_.bossHp;
  b.mp = b.maxMp = cfg_.bossMp;
  b.attack = cfg_.bossAttack;
  b.defense = cfg_.bossDefense;
  b.level = 60;
  b.name = idx == 0 ? "荒原巨兽" : (idx == 1 ? "深渊领主" : "冰霜女王");
  // 在锚点附近找干地出生
  double bx = hx, bz = hz;
  bool found = false;
  for (double r = 0; r <= 80 && !found; r += 4) {
    for (int k = 0; k < 24; k++) {
      double a = (double)k / 24.0 * 6.28318;
      double px = hx + std::cos(a) * r, pz = hz + std::sin(a) * r;
      if (terrainHeight(px, pz) > kWaterLevel + 1.0) { bx = px; bz = pz; found = true; break; }
    }
  }
  b.pos = {bx, terrainHeight(bx, bz) + b.radius + 0.3, bz};
  b.ai.homeX = bx;
  b.ai.homeZ = bz;
  addEntity(std::move(b));
  aliveBoss_++;
}
Entity* World::spawnPlayer(const std::string& username, Vec3* spawnHint) {
  Entity p = makePlayer(nextEntityId("p"), username);
  p.wid = nextWireId();
  if (spawnHint) {
    p.pos = *spawnHint;
  } else {
    Mulberry32 rng((uint32_t)(username.size() * 2654435761u + (uint64_t)entitySeq_));
    double x, y, z;
    randomSpawn(rng, x, y, z);
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
  if (!p || p->kind != EntityKind::Player) return false;
  Entity* t = findByWid(targetWid);
  if (!t || !t->active) return false;
  if (t->kind != EntityKind::Monster) return false;  // 只可攻击世界怪物/Boss
  uint64_t nowMs = tick_ * (uint64_t)cfg_.tickMs;
  // 攻击冷却（服务端权威，客户端不可伪造频率）
  if (nowMs - p->lastAttackMs < (uint64_t)(cfg_.playerAttackCdSec * 1000.0)) return false;
  // 范围判定
  if (p->pos.dist2D(t->pos) > cfg_.playerAttackRange) return false;
  p->lastAttackMs = nowMs;
  // 伤害公式（属性系统）：攻击力 × 浮动 ± 20% × 100/(100+防御)，最低 1 点
  double dmg = calcDamage(p->attack, t->defense, 0.8 + rng01() * 0.4);
  t->hp -= dmg;
  t->aggro[p->wid] += dmg;  // 仇恨表（世界共享核心状态）
  pushEvent(proto::EVT_DAMAGE, t->wid, (uint32_t)dmg, 0, 0);
  if (t->isBoss) markBossDirty();
  if (t->hp <= 0) {
    t->hp = 0;
    if (t->isBoss) {
      t->bossState = BS_DEAD;
      t->bossTarget = 0;
      t->respawnAtMs = nowMs + (uint64_t)(cfg_.bossRespawnSec * 1000.0);
      t->aggro.clear();
      t->vel = {0, 0, 0};
      if (aliveBoss_ > 0) aliveBoss_--;
      pushEvent(proto::EVT_DEATH, t->wid, p->wid, 0, 0);
      markBossDirty();
      // Boss 也掉落（掉落表按石像鬼，掉落更丰厚）
      rollDrops(*p, *t);
    } else {
      // 普通怪物死亡：失活 + 本区复活计时 + 掉落
      rollDrops(*p, *t);
      t->active = false;
      t->respawnAtMs = nowMs + (uint64_t)(cfg_.monsterRespawnSec * 1000.0);
      t->aggro.clear();
      t->vel = {0, 0, 0};
      pushEvent(proto::EVT_DEATH, t->wid, p->wid, 0, 0);
    }
  }
  return true;
}
// ---------- 物品/属性/商店/掉落 实现 ----------
// 位置哈希 → 怪物类型（确定性：复活后类型不变）
static const char* monsterTypeAt(double x, double z) {
  double h = hash2i((int64_t)std::floor(x / 8.0), (int64_t)std::floor(z / 8.0));
  if (h < 0.25) return "wolf";
  if (h < 0.50) return "goblin";
  if (h < 0.75) return "skeleton";
  return "gargoyle";
}
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
void World::despawnDrop(const std::string& id) {
  auto it = entities_.find(id);
  if (it == entities_.end()) return;
  widToId_.erase(it->second.wid);
  aoi_.remove(it->second.wid);
  chunks_.removeEntity(it->second);
  entities_.erase(it);
}
// 拾取地面掉落物
bool World::playerPickup(const std::string& playerId, uint32_t dropWid) {
  Entity* p = findEntity(playerId);
  if (!p || p->kind != EntityKind::Player) return false;
  Entity* d = findByWid(dropWid);
  if (!d || d->kind != EntityKind::Item || !d->active) return false;
  if (p->pos.dist2D(d->pos) > cfg_.pickupRangeM) return false;
  // 转移（金币是物品，都进背包/钱包）
  if (d->dropGold > 0) p->pl.gold += d->dropGold;
  if (d->dropItemId > 0) p->pl.inventory[d->dropItemId] += 1;
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
  double speed = cfg.maxMoveSpeed;
  uint64_t nowMs = w.tickCount() * (uint64_t)cfg.tickMs;
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p) continue;
    double mx = p->input.moveX, mz = p->input.moveZ;
    double len = std::hypot(mx, mz);
    double tx = 0, tz = 0;
    if (len > 1e-4) {
      tx = (mx / len) * speed;
      tz = (mz / len) * speed;
    }
    p->input.targetVX = tx;
    p->input.targetVZ = tz;
    if (p->input.jump) {
      p->input.jump = false;
      w.physics().tryJump(*p);
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
static void moveSystem(World& w, double dt) {
  for (const auto& pid : w.players()) {
    Entity* p = w.findEntity(pid);
    if (!p) continue;
    w.physics().setHorizontalVelocity(*p, p->input.targetVX, p->input.targetVZ, dt);
    w.physics().step(*p, dt);
  }
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || !e.active) continue;
    w.physics().setHorizontalVelocity(e, e.ai.targetVX, e.ai.targetVZ, dt);
    w.physics().step(e, dt);
  }
}
// 生物/NPC AI：大规模调度（AOI 激活 + 时间片轮转 + 距离分级）→ 状态机
static void aiSystem(World& w, double dt) {
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
