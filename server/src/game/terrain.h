// terrain.h - 确定性噪声 + 高度场地形（大型网游世界地图数据源）
// 算法必须与客户端 JS（client/js/terrain.js）及客户端预测（client/js/predict.js）**逐位一致**
// 地形要素：丘陵高度场 + 河流下切（湖泊/河流）+ 山脊抬升（悬崖/不可通行）
//           + 路径地图空洞（可到达区域收缩为走廊+空地）+ 地形编辑器编辑层（覆盖）
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include "../util/random.h"
namespace ew {
// 水面高度：地表高度低于该值的区域形成湖泊/河流
constexpr double kWaterLevel = -2.0;
// 河流半宽（米）
constexpr double kRiverHalfWidth = 7.0;
// 悬崖判定坡度（Δh/Δd，超过则不可通行）
constexpr double kCliffSlope = 1.30;
// 坡度采样间隔（米）
constexpr double kSlopeSample = 0.5;
// 整数坐标哈希 -> [0,1)，与 JS hash2i 一致
double hash2i(int64_t x, int64_t z);
// 2D value noise，与 JS noise2 一致
double noise2(double x, double z);
// fbm 分形叠加，与 JS fbm2 一致
double fbm2(double x, double z, int octaves = 5);
// 河流通道值 [0,1]：>0 表示处于河床带内（两条蜿蜒主河：东西向 + 南北向）
double riverBand(double x, double z);
// 路径地图空洞：可到达区域收缩为「主干道走廊 + 分支 + 随机空地」，
// 其余为空洞（渲染为白色空洞 / 不可通行）。确定性算法，与 JS terrainVoid 逐位一致。
bool terrainVoid(double x, double z);
// 地形高度：世界坐标 (x,z) -> 地表高度 y（含河床下切与山脊抬升），与 JS terrainHeight 一致
double terrainHeight(double x, double z);
// 该点最大局部坡度（Δh/Δd，两个轴方向取大值），与 JS terrainSlope 一致
double terrainSlope(double x, double z);
// 该点是否不可通行：空洞 / 深水 / 悬崖。客户端与服务端逐位一致
bool terrainBlocked(double x, double z);
// 出生点：在世界内随机找安全地表点（非水、非悬崖、非空洞）
void randomSpawn(Mulberry32& rng, double& x, double& y, double& z);

// ---- 地形编辑器编辑层（稀疏格子覆盖；客户端 JS terrain.js 同结构） ----
// 编辑器产物：对指定整数格覆盖「绝对高度 h」与「可通行性 v」，
// 未覆盖的格回退到程序化地形。height/blocked 查询先查编辑层。
struct EditCell {
  bool hasH = false;
  double h = 0.0;      // 绝对高度覆盖
  bool hasV = false;
  int8_t v = 0;        // 可通行覆盖：1=空洞(void/不可通行)，0=强制可通行
};
// 编辑层管理（单线程游戏循环内使用；持久化由调用方写 data/terrain_edit.json）
void terrainSetEdit(int64_t x, int64_t z, const EditCell& c);   // hasH/hasV 均 false 视为擦除
void terrainClearEdit();
size_t terrainEditSize();
const std::unordered_map<int64_t, EditCell>& terrainEdits();
// 序列化（JSON {"cells": {"x,z": {"h":..,"v":..}}}），与客户端一致
std::string terrainEditToJson();
bool terrainEditFromJson(const std::string& json);
} // namespace ew
