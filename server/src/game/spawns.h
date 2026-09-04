#pragma once
// 生物出生点配置（大型网游规模）：数据驱动出生点 + JSON 序列化
// 布局由世界初始化执行器（WorldInitializer）生成（代码不硬编码坐标）；
// 剧本编辑器可通过 GET/POST /api/spawns(/edit) 读写；服务端保存后热重载（reseed）。
#include <string>
#include <vector>
#include <cstdint>
#include "../config.h"
#include "npc.h"   // NpcTag 枚举定义在 NPC 插件头文件

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
  // NPC 扩展字段
  std::string npcId;          // NPC 唯一 ID（引用 NpcManager 中的 NpcDef，空=旧模式按 name）
  uint32_t npcTag = 0;        // NPC 标签位标志（NpcTag 组合，0=无标签）
  int npcGroup = 0;           // NPC 组别号
  int cityId = -1;            // 所属城市标号（-1=无绑定）
};

// 出生点配置表
class SpawnConfig {
public:
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
