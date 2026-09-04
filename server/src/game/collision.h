// collision.h - 2.5D 物体碰撞系统（大型网游规模）
//
// 层次：
//  1) 静态地形碰撞：确定性不可通行（湖泊/河流深水、悬崖/陡坡）。
//     与客户端预测（predict.js）使用同一 terrainBlocked，逐位一致，避免预测回退。
//  2) 圆盘-障碍碰撞：实体以水平圆盘（半径 radius）表示，移动时被障碍阻挡则沿轴滑动。
//  3) 实体-实体碰撞：动态实体（玩家/怪物/Boss/NPC）间圆形分离，无法互相穿透。
#pragma once
#include "entity.h"
#include <cmath>
namespace ew {
class Collision {
public:
  // 脱困搜索参数（与服务端/客户端 predict.js 逐位一致，不得单端修改）：
  // 8 向 × 5 环 × 0.2m/环 → 最大脱困半径 1.0m（约 2 个实体身位）
  static constexpr double kEscapeStep = 0.2;
  static constexpr int kEscapeRings = 5;

  // 点是否不可通行（委托 terrainBlocked；后续可扩展静态物体/建筑层）
  bool isBlocked(double x, double z) const;
  // 圆盘（半径 r）是否与障碍重叠：中心 + 圆周 8 点采样
  bool circleBlocked(double x, double z, double r) const;
  // 该位置是否可站立（出生/落点/复活校验）
  bool canStand(double x, double z, double r) const;
  // 带滑动的水平移动：实体已从 (ox,oz) 被移到 (nx,nz)，若与障碍重叠则按轴滑动回退
  // （模拟沿墙滑动）。返回是否发生碰撞阻挡（false=完全自由移动）。
  bool slideMove(Entity& e, double ox, double oz, double nx, double nz) const;
  // 脱困搜索：(ox,oz) 自身落在阻挡区时，由近及远做 8 向探测，取最近的严格可通行点
  // 写入 (ex,ez) 并返回 true；搜遍 kEscapeRings 环仍无落点则返回 false。
  bool escapeBlocked(double ox, double oz, double r, double& ex, double& ez) const;
  // 实体间圆形分离：两实体重叠则沿连线推挤（各分担一半），返回是否发生分离
  static bool separate(Entity& a, Entity& b);
};
} // namespace ew
