// terrain.h - 确定性噪声 + 高度场地形（大型网游世界地图数据源）
// 高度场算法必须与客户端 JS（client/js/terrain.js）及客户端预测（client/js/predict.js）**逐位一致**
// 地形要素：丘陵高度场
//           + 可通行 mask（数据驱动：由世界初始化执行器生成 / 数据库加载，不再程序化硬编码）
//           + 地形编辑器编辑层（覆盖）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include "../util/random.h"
namespace ew {
// 水面高度：地表高度低于该值的区域形成湖泊
constexpr double kWaterLevel = -2.0;
// 悬崖判定坡度（Δh/Δd，超过则不可通行）
constexpr double kCliffSlope = 1.30;
// 坡度采样间隔（米）
constexpr double kSlopeSample = 0.5;
// 整数坐标哈希 -> [0,1)，与 JS hash2i 一致
double hash2i(int64_t x, int64_t z);
// 设置地形种子偏移：使噪声地形随种子变化（hash2i 引入 seedOffset）。
// 服务端在 generateWorld 开头调用；客户端在加载 mask 时随 seedOffset 字段一并设置。
void setTerrainSeed(int32_t offset);
// 2D value noise，与 JS noise2 一致
double noise2(double x, double z);
// fbm 分形叠加，与 JS fbm2 一致
double fbm2(double x, double z, int octaves = 5);
// 可通行 mask（数据驱动）：1=可通行 / 0=空洞。覆盖世界 [-off, n-off)，每格 1 米。
// 由世界初始化执行器（WorldInitializer）生成、数据库模式从库加载，并通过 /api/terrain/mask
// 下发客户端；代码中不再程序化生成布局。mask 未就绪时 terrainVoid 一律返回 true（阻挡）。
void terrainSetWalkMask(std::vector<uint8_t> mask, int n, int off); // 安装可通行 mask
bool terrainWalkMaskReady();                                        // mask 是否已就绪
int  terrainWalkMaskN();                                            // mask 边长（格）
int  terrainWalkMaskOff();                                          // mask 原点偏移（世界 -off 起）
const std::vector<uint8_t>& terrainWalkMask();                      // mask 原始数据（1=可通行）
// 自然地形阻挡：仅深水 / 悬崖（不含空洞 mask）。供世界初始化生长可通行区域时判定“天然干地”。
bool terrainNaturalBlocked(double x, double z);
// 可通行 mask 空洞：可到达区域外为空洞（渲染为白色空洞 / 不可通行）。数据驱动，与客户端一致。
bool terrainVoid(double x, double z);
// 地形高度：世界坐标 (x,z) -> 地表高度 y，与 JS terrainHeight 一致
double terrainHeight(double x, double z);
// 权威贴地高度：实体中心 y = 地表 + 半径。全服务端「实体贴地」语义的唯一来源，
// Physics::step 地表钳制 / moveEntityCollide 贴地 / handleInput 采纳 / 击退落回 /
// 传送 / 复活 / 生成 一律走它。历史上这些点各写各的：生成与传送路径多加了 0.3，
// 击退路径漏加 radius —— 前者让其他玩家看到实体浮空 0.3m（客户端对「其他玩家」
// 直接 lerp 服务端 Y，且该偏移还会污染 netcode 相对坐标的解码基准 refY），
// 后者让被击退者的球体埋进地表 radius 米。
// 注：掉落物用独立的悬空偏移（makeDrop 处 +0.35），不属于实体贴地语义。
inline double groundFootY(double x, double z, double radius) {
  return terrainHeight(x, z) + radius;
}
// 该点最大局部坡度（Δh/Δd，两个轴方向取大值），与 JS terrainSlope 一致
double terrainSlope(double x, double z);
// 该点是否不可通行：空洞 / 深水 / 悬崖。客户端与服务端逐位一致
bool terrainBlocked(double x, double z);
// 出生点：在世界内随机找安全地表点（非水、非悬崖、非空洞）
// 随机可通行出生点：环形 [minR, maxR]，默认 [0,60]（保证避开空洞/深水/悬崖）
void randomSpawn(Mulberry32& rng, double& x, double& y, double& z,
                 double minR = 0.0, double maxR = 60.0);
// 城镇出生点：主城圆盘内（出生/商店开放空地，r<=8.2 保证玩家圆盘可容纳）
void townSpawn(Mulberry32& rng, double& x, double& y, double& z);
// 城镇半径常量（与 void mask 主城圆盘 r=9 对应，留玩家半径余量）
constexpr double kTownSpawnRadius = 8.2;

// ---- 地形编辑器编辑层（稀疏格子覆盖；客户端 JS terrain.js 同结构） ----
// 编辑器产物：对指定整数格覆盖「绝对高度 h」与「可通行性 v」，
// 未覆盖的格回退到程序化地形。height/blocked 查询先查编辑层。
struct EditCell {
  bool hasH = false;
  double h = 0.0;      // 绝对高度覆盖
  bool hasV = false;
  int8_t v = 0;        // 可通行覆盖：1=空洞(void/不可通行)，0=强制可通行
};
// 编辑层管理（单线程游戏循环内使用；数据库模式由 Store 持久化，内存模式重启即重置）
void terrainSetEdit(int64_t x, int64_t z, const EditCell& c);   // hasH/hasV 均 false 视为擦除
void terrainClearEdit();
size_t terrainEditSize();
const std::unordered_map<int64_t, EditCell>& terrainEdits();
// 序列化（JSON {"cells": {"x,z": {"h":..,"v":..}}}），与客户端一致
std::string terrainEditToJson();
bool terrainEditFromJson(const std::string& json);
} // namespace ew
