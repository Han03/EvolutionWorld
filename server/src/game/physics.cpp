// physics.cpp - 物理实现（重力/摩擦/加速度/地表碰撞，无跳跃）
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

  // 4) 地表碰撞（footY = 权威贴地高度，与 handleInput 采纳/击退/传送/复活 同一语义）
  double footY = groundFootY(p.x, p.z, e.radius);
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

} // namespace ew
