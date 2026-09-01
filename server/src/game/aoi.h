// aoi.h - AOI（Area of Interest）空间网格兴趣管理
// 大规模 MMO 核心：把"对所有实体两两判定"降为"网格哈希 + 局部扫描"（O(n) 级）
#pragma once
#include <cstdint>
#include <cstddef>
#include <unordered_map>
#include <unordered_set>
#include <vector>
namespace ew {
class AoiGrid {
public:
  explicit AoiGrid(double cellSize) : cell_(cellSize) {}
  // 实体移动/进入 → 更新网格归属
  void move(uint32_t wid, double x, double z);
  void remove(uint32_t wid);
  // 返回 (x,z) 半径 range 内的实体 wid（已按实际距离过滤）
  std::vector<uint32_t> inRange(double x, double z, double range) const;
  void clear();
  size_t entityCount() const { return cellOf_.size(); }
private:
  static int64_t cellKey(int64_t ix, int64_t iz) {
    return (ix << 32) ^ (iz & 0xFFFFFFFFLL);
  }
  double cell_;
  // wid -> 所在网格
  std::unordered_map<uint32_t, std::pair<int64_t, int64_t>> cellOf_;
  // 网格键 -> 实体集合
  std::unordered_map<int64_t, std::unordered_set<uint32_t>> cells_;
};
} // namespace ew
