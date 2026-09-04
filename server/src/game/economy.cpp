// economy.cpp - 经济系统门面实现（统一驱动各子系统配置加载）
#include "economy.h"
#include <cstdio>

namespace ew {

void EconomySystem::loadDefaults() {
  enhance_.loadDefaults();   // 强化 + 分解（同属铁匠域，配置一并在 enhance_ 内）
  craft_.loadDefaults();     // 合成配方（配方域）
  fprintf(stderr, "[economy] 经济系统默认配置加载完成（强化 %zu 级 + 分解 %zu 档 + 合成 %zu 配方）\n",
          enhance_.config().levels.size(), enhance_.decomposeConfig().rules.size(),
          craft_.recipes().size());
}

void EconomySystem::loadFromJson(const std::string& dir) {
  enhance_.loadFromJson(dir);   // 强化 + 分解热替换
  craft_.loadFromJson(dir);     // 合成配方热替换
}

} // namespace ew
