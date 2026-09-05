// economy.h - 经济系统门面（聚合强化/分解/合成配置 + 统一加载入口）
//
// 设计要点（门面模式，World 持有唯一 EconomySystem）：
//  - 统一加载：loadFromJson 一次性驱动各经济子系统配置
//  - 阶段隔离：阶段2=强化（EnhanceSystem）；阶段3=分解（并入 EnhanceSystem，同属铁匠域）；阶段4=合成（CraftSystem）
//  - 对外暴露子访问器 enhance()/craft()，隔离具体实现，便于独立替换与测试
#pragma once
#include <string>
#include "enhance.h"
#include "craft.h"

namespace ew {

class EconomySystem {
public:
  void loadFromJson(const std::string& dir);  // 从 data/*.json 加载各子系统配置（enhance.json / craft.json 等）

  // ---- 子系统访问器 ----
  EnhanceSystem& enhance() { return enhance_; }   // 强化 + 分解（铁匠域）
  const EnhanceSystem& enhance() const { return enhance_; }
  CraftSystem& craft() { return craft_; }         // 合成（配方域）
  const CraftSystem& craft() const { return craft_; }

private:
  EnhanceSystem enhance_;
  CraftSystem craft_;
};

} // namespace ew
