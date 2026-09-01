// world.cpp
#include "world.h"
#include "terrain.h"
#include <algorithm>
#include <cmath>

namespace ew {

// 简易随机源（AI 用；单线程）
static Mulberry32 gAiRng(0xC0FFEE);
static double rng01() { return gAiRng.next(); }

// 默认系统（前向声明，定义在文件后部）
static void inputSystem(World& w, double dt);
static void moveSystem(World& w, double dt);
static void aiSystem(World& w, double dt);

World::World(const Config& cfg)
    : cfg_(cfg), physics_(cfg), chunks_(*this, cfg), rng_((uint32_t)cfg.worldSeed ^ 0x51ab) {
  addSystem(10, "input", inputSystem);
  addSystem(20, "move", moveSystem);
  addSystem(30, "ai", aiSystem);
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
  entities_[id] = std::move(e);
  chunks_.updateEntityChunk(entities_[id]);
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
}

Entity* World::spawnPlayer(const std::string& username, Vec3* spawnHint) {
  Entity p = makePlayer(nextEntityId("p"), username);
  if (spawnHint) {
    p.pos = *spawnHint;
  } else {
    Mulberry32 rng((uint32_t)(username.size() * 2654435761u + (uint64_t)entitySeq_));
    double x, y, z;
    randomSpawn(rng, x, y, z);
    p.pos = {x, terrainHeight(x, z) + p.radius + 0.3, z};
  }
  std::string id = p.id; // 移动前保存 id
  entities_[id] = std::move(p);
  chunks_.updateEntityChunk(entities_[id]);
  players_.insert(id);
  return &entities_[id];
}

void World::despawnPlayer(const std::string& id) {
  auto it = entities_.find(id);
  if (it != entities_.end()) {
    chunks_.removeEntity(it->second);
    entities_.erase(it);
  }
  players_.erase(id);
  chunks_.removePlayer(id);
}

// ---------------- 系统实现 ----------------

static void inputSystem(World& w, double) {
  const auto& cfg = w.config();
  double speed = cfg.maxMoveSpeed;
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

static void aiSystem(World& w, double dt) {
  for (auto& [id, e] : w.entitiesMut()) {
    (void)id;
    if (e.kind == EntityKind::Player || !e.active) continue;
    if (!w.chunks().isEntityVisible(e)) continue;
    auto& ai = e.ai;
    ai.timer -= dt;
    if (ai.timer <= 0) {
      ai.dirX = (rng01() * 2.0 - 1.0);
      ai.dirZ = (rng01() * 2.0 - 1.0);
      ai.timer = 2.0 + rng01() * 4.0;
    }
    double tx = ai.dirX * ai.speed;
    double tz = ai.dirZ * ai.speed;
    if (std::hypot(e.pos.x - ai.homeX, e.pos.z - ai.homeZ) > 20.0) {
      double back = std::atan2(ai.homeX - e.pos.x, ai.homeZ - e.pos.z);
      tx = std::sin(back) * ai.speed;
      tz = std::cos(back) * ai.speed;
    }
    ai.targetVX = tx;
    ai.targetVZ = tz;
  }
}

// ---------------- tick ----------------

void World::tick() {
  double dt = cfg_.tickMs / 1000.0;
  tick_++;
  updateSystems(dt);

  // 同步实体区块归属
  for (auto& [id, e] : entities_) {
    (void)id;
    chunks_.updateEntityChunk(e);
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
