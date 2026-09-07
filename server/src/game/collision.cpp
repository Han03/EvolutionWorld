// collision.cpp - 2.5D 物体碰撞系统实现
// 浮岛世界设定：无建筑墙壁概念，允许模型一半悬空（浮岛边缘/水域边缘悬空是自然表现）。
// 因此静态地形碰撞统一为「中心点判定」：只判断坐标点是否落入不可通行区
// （湖泊/河流/悬崖/陡坡），半径仅用于渲染/实体间距，不参与地形碰撞。
// 与客户端 predict.js 的 circleBlocked 同语义，双端一致。
#include "collision.h"
#include "terrain.h"
namespace ew {
bool Collision::isBlocked(double x, double z) const {
  return terrainBlocked(x, z);
}
bool Collision::circleBlocked(double x, double z, double r) const {
  // 中心点判定：r 保留仅为调用方兼容（实体半径），不参与计算——
  // 悬空/贴边由设定允许，圆心可通行即通过。slideMove/escapeBlocked/canStand 跟随。
  return isBlocked(x, z);
}
bool Collision::canStand(double x, double z, double r) const {
  return !circleBlocked(x, z, r);
}
// 8 向单位向量表：写成字面量而非 cos/sin —— 客户端 predict.js 必须逐位一致地复刻本搜索，
// 而 libm 与 JS Math 的三角函数末位 ulp 可能不同，边界探测点会因此选到不同方向。
static const double kEscapeDir[8][2] = {
  { 1.0, 0.0 },
  { 0.7071067811865476, 0.7071067811865476 },
  { 0.0, 1.0 },
  { -0.7071067811865476, 0.7071067811865476 },
  { -1.0, 0.0 },
  { -0.7071067811865476, -0.7071067811865476 },
  { 0.0, -1.0 },
  { 0.7071067811865476, -0.7071067811865476 },
};
// 脱困搜索：由近及远逐环探测，取第一个严格可通行点。最坏情况代价
// kEscapeRings*8 次 circleBlocked（= 40*9 次 terrainBlocked），仅在起点已被阻挡的
// 退化状态下触发，不影响正常移动热路径。
bool Collision::escapeBlocked(double ox, double oz, double r, double& ex, double& ez) const {
  for (int ring = 1; ring <= kEscapeRings; ring++) {
    const double d = kEscapeStep * (double)ring;
    for (int i = 0; i < 8; i++) {
      const double cx = ox + kEscapeDir[i][0] * d;
      const double cz = oz + kEscapeDir[i][1] * d;
      if (!circleBlocked(cx, cz, r)) { ex = cx; ez = cz; return true; }
    }
  }
  return false;
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
    // 兜底：三个滑动候选全被阻挡。旧实现无条件退回起点 (ox,oz)，但起点自身也可能
    // 落在阻挡区（出生/复活用点判定而非圆盘判定、外力直接改写 pos、mask 运行时变更），
    // 此时退回起点等于永久卡死：每次上报都判 terrain_blocked，且防作弊的 clampToWalkable
    // 因锚点不可通行而放弃夹紧，客户端被反复校正回同一个坑里。故补一次脱困搜索。
    double ex = 0, ez = 0;
    if (circleBlocked(ox, oz, r) && escapeBlocked(ox, oz, r, ex, ez)) {
      e.pos.x = ex; e.pos.z = ez;
    } else {
      e.pos.x = ox; e.pos.z = oz;
    }
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
