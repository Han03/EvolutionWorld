// economy.cpp - 经济系统门面实现（统一驱动各子系统配置加载）
#include "economy.h"
#include <cstdio>

namespace ew {

void EconomySystem::loadFromJson(const std::string& dir) {
  enhance_.loadFromJson(dir);   // 强化 + 分解热替换
  craft_.loadFromJson(dir);     // 合成配方热替换
}

} // namespace ew
