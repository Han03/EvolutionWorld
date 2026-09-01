// terrain.h - 确定性噪声 + SDF 地形
// 算法必须与客户端 GLSL（client/js/glsl.js）及客户端预测（client/js/predict.js）**逐位一致**
#pragma once
#include <cstdint>
#include "../util/random.h"

namespace ew {

// 整数坐标哈希 -> [0,1)，与 GLSL hash2i / JS hash2i 一致
double hash2i(int64_t x, int64_t z);
// 2D value noise，与 GLSL noise2 / JS noise2 一致
double noise2(double x, double z);
// fbm 分形叠加，与 GLSL fbm2 / JS fbm2 一致
double fbm2(double x, double z, int octaves = 5);
// 地形高度：世界坐标 (x,z) -> 地表高度 y，与 GLSL terrainHeight / JS terrainHeight 一致
double terrainHeight(double x, double z);
// SDF：点到地表的有符号距离
inline double sdfGround(double x, double y, double z) { return y - terrainHeight(x, z); }

// 出生点：在世界内随机找安全地表点
void randomSpawn(Mulberry32& rng, double& x, double& y, double& z);

} // namespace ew
