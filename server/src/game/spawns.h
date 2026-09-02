#pragma once
// 生物出生点配置（大型网游规模）：数据驱动出生点 + JSON 覆盖（data/spawns.json）
// 剧本编辑器通过 GET/POST /api/spawns(/edit) 读写；服务端启动加载、保存后热重载（reseed）。
#include <string>
#include <vector>
#include "../config.h"

namespace ew {

// 出生点 kind 常量
enum SpawnKind : uint8_t {
  SP_MONSTER = 0,
  SP_NPC = 1,
  SP_BOSS = 2,
};

// 单个出生点
struct SpawnPoint {
  uint8_t kind = SP_MONSTER;  // 0 monster / 1 npc / 2 boss
  std::string type;           // monster/boss 类型（wolf/goblin/skeleton/gargoyle）
  std::string name;           // NPC/Boss 名称（可选，覆盖默认）
  int shopId = 0;             // NPC 商店 id（0=无）
  double x = 0, z = 0;
  int count = 1;              // 该点刷怪数量（monster）
};

// 出生点配置表
class SpawnConfig {
public:
  // 内置默认出生点（确定性：seeded by worldSeed）：
  //   - 24 只怪物：环带 [20,110]m、按距离阶梯类型（近郊狼→中郊哥布林→远郊骷髅→边境石像鬼）
  //   - 12 个城镇 NPC（主城圆盘锚点，首位=商店老板）
  //   - 3 个世界 Boss（远离出生点的可通行锚点）
  void loadDefaults(const Config& cfg);
  bool fromJson(const std::string& json);       // {spawns:[{kind,type,name,shopId,x,z,count},...]}
  std::string toJson() const;
  bool loadFile(const std::string& path);       // 有则加载，无则保留当前
  bool saveFile(const std::string& path) const;
  const std::vector<SpawnPoint>& list() const { return list_; }
  std::vector<SpawnPoint>& listMut() { return list_; }
  size_t size() const { return list_.size(); }
  void clear() { list_.clear(); }

private:
  std::vector<SpawnPoint> list_;
};

} // namespace ew
