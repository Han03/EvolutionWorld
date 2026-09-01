// physics.h - 简单物理系统（重力/地表碰撞/加速度/跳跃）
#pragma once
#include "entity.h"
#include "../config.h"

namespace ew {

class Physics {
public:
  explicit Physics(const Config& cfg) : cfg_(cfg) {}

  // 单实体一帧积分：重力 -> 水平阻尼 -> 积分 -> 地表碰撞
  void step(Entity& e, double dt);
  // 水平速度向目标逼近（加速度模型）
  void setHorizontalVelocity(Entity& e, double targetX, double targetZ, double dt);
  // 触发跳跃（仅地面）
  bool tryJump(Entity& e);

private:
  const Config& cfg_;
};

} // namespace ew
