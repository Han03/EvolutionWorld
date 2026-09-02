// terrain.h - 确定性噪声 + 高度场地形（大型网游世界地图数据源）
// 算法必须与客户端 JS（client/js/terrain.js）及客户端预测（client/js/predict.js）**逐位一致**
// 地形要素：丘陵高度场 + 河流下切（湖泊/河流）+ 山脊抬升（悬崖/不可通行）
#pragma once
#include <cstdint>
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
// 地形高度：世界坐标 (x,z) -> 地表高度 y（含河床下切与山脊抬升），与 JS terrainHeight 一致
double terrainHeight(double x, double z);
// 该点最大局部坡度（Δh/Δd，两个轴方向取大值），与 JS terrainSlope 一致
double terrainSlope(double x, double z);
// 该点是否不可通行：深水（湖泊/河流床）/ 悬崖 / 陡坡。客户端与服务端逐位一致
bool terrainBlocked(double x, double z);
// 出生点：在世界内随机找安全地表点（非水、非悬崖）
void randomSpawn(Mulberry32& rng, double& x, double& y, double& z);
} // namespace ew
