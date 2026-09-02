// collision.cpp - 2.5D 物体碰撞系统实现
#include "collision.h"
#include "terrain.h"
namespace ew {
bool Collision::isBlocked(double x, double z) const {
  return terrainBlocked(x, z);
}
bool Collision::circleBlocked(double x, double z, double r) const {
  // 中心
  if (isBlocked(x, z)) return true;
  // 圆周 8 点采样（覆盖圆盘外缘；半径大的实体用更多采样）
  const int n = 8;
  for (int i = 0; i < n; i++) {
    double a = (double)i / (double)n * 6.283185307179586;
    if (isBlocked(x + r * std::cos(a), z + r * std::sin(a))) return true;
  }
  return false;
}
bool Collision::canStand(double x, double z, double r) const {
  return !circleBlocked(x, z, r);
}
// 带滑动：实体已从 (ox,oz) 移到 (nx,nz)，若被障碍阻挡则逐轴回退，模拟沿墙滑动
bool Collision::slideMove(Entity& e, double ox, double oz, double nx, double nz) const {
  const double r = e.radius;
  if (!circleBlocked(nx, nz, r)) {
    e.pos.x = nx;
    e.pos.z = nz;
    return false; // 完全自由
  }
  // X 轴单独尝试（沿 X 滑动 → 结果 (nx, oz)）
  bool okX = !circleBlocked(nx, oz, r);
  // Z 轴单独尝试（沿 Z 滑动 → 结果 (ox, nz)）
  bool okZ = !circleBlocked(ox, nz, r);
  if (okX && okZ) {
    // 都可行：选择位移更大的轴（自然的沿墙滑动）
    if (std::abs(nx - ox) >= std::abs(nz - oz)) { e.pos.x = nx; e.pos.z = oz; }
    else { e.pos.x = ox; e.pos.z = nz; }
  } else if (okX) {
    e.pos.x = nx; e.pos.z = oz;
  } else if (okZ) {
    e.pos.x = ox; e.pos.z = nz;
  } else {
    e.pos.x = ox; e.pos.z = oz;
  }
  return true; // 发生阻挡
}
// 实体间圆形分离：重叠则沿连线各推开一半（软碰撞，可通行但互相推挤）
bool Collision::separate(Entity& a, Entity& b) {
  double dx = b.pos.x - a.pos.x;
  double dz = b.pos.z - a.pos.z;
  double d2 = dx * dx + dz * dz;
  double rr = a.radius + b.radius;
  if (d2 <= 0.0 || d2 >= rr * rr) return false;
  double d = std::sqrt(d2);
  double overlap = rr - d;
  double nx = dx / d, nz = dz / d;
  a.pos.x -= nx * overlap * 0.5;
  a.pos.z -= nz * overlap * 0.5;
  b.pos.x += nx * overlap * 0.5;
  b.pos.z += nz * overlap * 0.5;
  return true;
}
} // namespace ew
