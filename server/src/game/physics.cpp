// physics.cpp - 物理实现（与旧 JS 服务端逻辑完全一致，保证客户端预测可复现）
#include "physics.h"
#include "terrain.h"
#include <cmath>
#include <algorithm>

namespace ew {

void Physics::step(Entity& e, double dt) {
  if (!e.active) return;
  auto& p = e.pos;
  auto& v = e.vel;

  // 1) 重力
  v.y += cfg_.gravity * dt;

  // 2) 水平阻尼
  double hSpeed = std::hypot(v.x, v.z);
  if (hSpeed > 0) {
    double drag = cfg_.friction * dt;
    double ns = std::max(0.0, hSpeed - drag);
    double scale = ns / hSpeed;
    v.x *= scale;
    v.z *= scale;
  }

  // 3) 积分位置
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;

  // 4) 地表碰撞
  double groundY = terrainHeight(p.x, p.z);
  double footY = groundY + e.radius;
  if (p.y <= footY) {
    p.y = footY;
    v.y = 0;
    e.grounded = true;
  } else {
    e.grounded = false;
  }
}

void Physics::setHorizontalVelocity(Entity& e, double targetX, double targetZ, double dt) {
  auto& v = e.vel;
  double curX = v.x, curZ = v.z;
  double accel = cfg_.acceleration * dt;
  double d = std::hypot(targetX - curX, targetZ - curZ);
  if (d <= accel) {
    v.x = targetX;
    v.z = targetZ;
  } else {
    double k = accel / d;
    v.x = curX + (targetX - curX) * k;
    v.z = curZ + (targetZ - curZ) * k;
  }
}

bool Physics::tryJump(Entity& e) {
  if (e.grounded) {
    e.vel.y = cfg_.jumpVelocity;
    e.grounded = false;
    return true;
  }
  return false;
}

} // namespace ew
