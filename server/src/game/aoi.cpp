// aoi.cpp - AOI 网格实现
#include "aoi.h"
#include <cmath>
namespace ew {
void AoiGrid::move(uint32_t wid, double x, double z) {
  int64_t ix = (int64_t)std::floor(x / cell_);
  int64_t iz = (int64_t)std::floor(z / cell_);
  auto it = cellOf_.find(wid);
  if (it != cellOf_.end()) {
    if (it->second.first == ix && it->second.second == iz) return; // 未跨格
    cells_[cellKey(it->second.first, it->second.second)].erase(wid);
  }
  cellOf_[wid] = {ix, iz};
  cells_[cellKey(ix, iz)].insert(wid);
}
void AoiGrid::remove(uint32_t wid) {
  auto it = cellOf_.find(wid);
  if (it == cellOf_.end()) return;
  auto& set = cells_[cellKey(it->second.first, it->second.second)];
  set.erase(wid);
  if (set.empty()) cells_.erase(cellKey(it->second.first, it->second.second));
  cellOf_.erase(it);
}
std::vector<uint32_t> AoiGrid::inRange(double x, double z, double range) const {
  std::vector<uint32_t> out;
  int span = (int)std::ceil(range / cell_);
  int64_t cx = (int64_t)std::floor(x / cell_);
  int64_t cz = (int64_t)std::floor(z / cell_);
  for (int64_t i = cx - span; i <= cx + span; i++) {
    for (int64_t j = cz - span; j <= cz + span; j++) {
      auto it = cells_.find(cellKey(i, j));
      if (it == cells_.end()) continue;
      for (uint32_t wid : it->second) {
        (void)wid;
        // 距离过滤由调用方完成（需要实体坐标），此处仅收集候选
        out.push_back(wid);
      }
    }
  }
  return out;
}
void AoiGrid::clear() {
  cellOf_.clear();
  cells_.clear();
}
} // namespace ew
