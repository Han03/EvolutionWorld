// entity.h - 实体定义（玩家/怪物/NPC），预留扩展位
#pragma once
#include <string>
#include <cstdint>
#include <cmath>
#include "util/json.h"

namespace ew {

struct Vec3 {
  double x = 0, y = 0, z = 0;
  double dist2D(const Vec3& o) const { double dx = x - o.x, dz = z - o.z; return std::sqrt(dx*dx + dz*dz); }
  double dist3D(const Vec3& o) const { double dx = x - o.x, dy = y - o.y, dz = z - o.z; return std::sqrt(dx*dx+dy*dy+dz*dz); }
};

enum class EntityKind { Player, Monster, Npc };

struct Entity {
  std::string id;
  EntityKind kind = EntityKind::Monster;
  Vec3 pos;
  Vec3 vel;
  double radius = 0.5;
  bool grounded = false;
  bool active = true;

  // 玩家扩展字段
  std::string username;
  // AI 扩展字段
  struct {
    double targetVX = 0, targetVZ = 0;
    double homeX = 0, homeZ = 0;
    double dirX = 0, dirZ = 0;
    double timer = 0;
    double speed = 1.0;
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
Entity makeMonster(const std::string& id);
Entity makeNpc(const std::string& id);

} // namespace ew
