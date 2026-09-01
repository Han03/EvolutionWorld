// world.cpp - 世界管理器实现 + 世界怪物/世界Boss 状态共享（服务端单点权威）
#include "world.h"
#include "terrain.h"
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
// 默认系统（前向声明，定义在文件后部）
static void inputSystem(World& w, double dt);
static void moveSystem(World& w, double dt);
static void aiSystem(World& w, double dt);
static void bossSystem(World& w, double dt);
static void respawnSystem(World& w, double dt);
World::World(const Config& cfg)
    : cfg_(cfg), physics_(cfg), chunks_(*this, cfg),
      aoi_(cfg.aoiCellSizeM), rng_((uint32_t)cfg.worldSeed ^ 0x51ab) {
  addSystem(10, "input", inputSystem);
  addSystem(20, "move", moveSystem);
  addSystem(30, "ai", aiSystem);
  addSystem(40, "boss", bossSystem);
  addSystem(50, "respawn", respawnSystem);
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
    Entity m = makeMonster(nextEntityId("m"));
    double x, y, z;
    randomSpawn(rng_, x, y, z);
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
    addEntity(std::move(n));
  }
  // 世界 Boss：全区共享实体（全局模拟 + Zone 广播）
  int bossN = std::min(cfg_.bossCount, (int)kBossAnchors.size());
  for (int i = 0; i < bossN; i++) {
    spawnBoss(i, kBossAnchors[i].first, kBossAnchors[i].second);
  }
}
void World::spawnBoss(int idx, double hx, double hz) {
  Entity b = makeMonster(nextEntityId("boss"));
  b.isBoss = true;
  b.radius = 1.4;
  b.hp = b.maxHp = cfg_.bossHp;
  b.attack = cfg_.bossAttack;
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
  // 伤害 = 攻击力 ± 20% 浮动（完全服务端计算）
  double dmg = p->attack * (0.8 + rng01() * 0.4);
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
    } else {
      // 普通怪物死亡：失活 + 本区复活计时
      t->active = false;
      t->respawnAtMs = nowMs + (uint64_t)(cfg_.monsterRespawnSec * 1000.0);
      t->aggro.clear();
      t->vel = {0, 0, 0};
      pushEvent(proto::EVT_DEATH, t->wid, p->wid, 0, 0);
    }
  }
  return true;
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
    // 脱战回血（5s 未受击）
    if (p->hp > 0 && p->hp < p->maxHp && nowMs - p->lastDamageMs >= 5000) {
      p->hp = std::min(p->maxHp, p->hp + cfg.playerRegenPerSec * dt);
    }
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
