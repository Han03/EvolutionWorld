// npc.h - NPC 管理插件（大型网游规模，ID 驱动 + 标签功能路由）
//
// 设计要点（插件模式，与 QuestSystem/FriendSystem 同级）：
//  - NPC 按唯一 ID 管理：每个 NPC 定义有全局唯一 npcId（如 "merchant_001"）
//  - 相同 npcId 不能同时出现在地图上（spawn 时校验，已存在则拒绝）
//  - 类型标签决定功能：NpcTag 位标志组合，客户端据此渲染交互选项
//  - 数据驱动：内置默认 NPC 花名册 + JSON 覆盖 + 编辑器热替换
//  - 通过 World 持有 unique_ptr 集成，接口清晰、可独立替换
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <cstdint>
#include "util/json.h"

namespace ew {

// ---------- NPC 标签常量（位标志，可组合；客户端据此决定交互菜单项） ----------
enum NpcTag : uint32_t {
  NPC_TAG_BASIC      = 1 << 0,  // 基础功能（对话/闲聊）
  NPC_TAG_QUEST      = 1 << 1,  // 任务（可接取/提交任务）
  NPC_TAG_SHOP       = 1 << 2,  // 商店（打开商品列表）
  NPC_TAG_BLACKSMITH = 1 << 3,  // 铁匠（装备强化/分解）
  NPC_TAG_TELEPORT   = 1 << 4,  // 传送（城市间传送）
  NPC_TAG_DAILY      = 1 << 5,  // 日常任务（每日刷新可接）
  NPC_TAG_CRAFT      = 1 << 6,  // 合成（物品合成）
  NPC_TAG_BANK       = 1 << 7,  // 仓库（物品存储）
};

// NPC 标签名（调试/编辑器用）
struct NpcTagInfo { uint32_t tag; const char* name; const char* desc; };
inline const NpcTagInfo* npcTagTable() {
  static const NpcTagInfo t[] = {
    { NPC_TAG_BASIC,      "基础",   "对话/闲聊" },
    { NPC_TAG_QUEST,      "任务",   "接取/提交任务" },
    { NPC_TAG_SHOP,       "商店",   "打开商品列表" },
    { NPC_TAG_BLACKSMITH, "铁匠",   "装备强化/分解" },
    { NPC_TAG_TELEPORT,   "传送",   "城市间传送" },
    { NPC_TAG_DAILY,      "日常",   "每日可接任务" },
    { NPC_TAG_CRAFT,      "合成",   "物品合成" },
    { NPC_TAG_BANK,       "仓库",   "物品存储" },
  };
  return t;
}
inline int npcTagTableSize() { return 8; }

// ---------- NPC 定义（按唯一 ID 管理，模板数据） ----------
struct NpcDef {
  std::string npcId;       // 全局唯一 ID（如 "merchant_001"）
  std::string name;        // 显示名（如 "杂货商人·李四"）
  std::string desc;        // 描述/背景故事
  std::string model;       // 模型/外观标识（客户端映射颜色/图标）
  uint32_t npcTag = 1;     // 标签位组合（NpcTag，决定 NPC 可交互功能）
  int shopId = 0;          // 关联商店 ID（0=无，需 npcTag 含 SHOP）
  int level = 1;           // 等级（显示用，大型网游 NPC 有等级）
  double wanderRadius = 0; // 游走半径（0=不游走，守店/站岗）
  std::string dialogue;    // 默认对话文本（客户端展示）
};

// ---------- NPC 管理器（插件：管理 NPC 定义注册 + 运行时唯一性追踪） ----------
class NpcManager {
public:
  NpcManager();

  // ---- 定义注册（数据层） ----
  void loadDefaults();                              // 内置默认 NPC 花名册
  bool loadFromJson(const std::string& dir);        // 可选外部 JSON 覆盖
  const NpcDef* npc(const std::string& npcId) const;// 按 ID 查定义
  const std::unordered_map<std::string, NpcDef>& npcs() const { return npcs_; }

  // ---- 运行时追踪（唯一性：相同 npcId 不能同时出现在地图上） ----
  bool markSpawned(const std::string& npcId);       // 标记已生成，返回 false 表示已存在
  void markDespawned(const std::string& npcId);     // 移除已生成标记
  bool isSpawned(const std::string& npcId) const;   // 查询是否已在地图上
  const std::unordered_set<std::string>& spawnedIds() const { return spawned_; }
  void clearSpawned();                              // 清空（热重载前调用）

  // ---- 标签功能查询（客户端据此决定交互选项） ----
  static bool hasTag(uint32_t npcTag, NpcTag tag) { return (npcTag & tag) != 0; }
  static bool canShop(uint32_t t)    { return hasTag(t, NPC_TAG_SHOP); }
  static bool canQuest(uint32_t t)   { return hasTag(t, NPC_TAG_QUEST); }
  static bool canTeleport(uint32_t t){ return hasTag(t, NPC_TAG_TELEPORT); }
  static bool canDaily(uint32_t t)   { return hasTag(t, NPC_TAG_DAILY); }
  static bool canCraft(uint32_t t)   { return hasTag(t, NPC_TAG_CRAFT); }
  static bool canBank(uint32_t t)    { return hasTag(t, NPC_TAG_BANK); }
  static bool canSmith(uint32_t t)   { return hasTag(t, NPC_TAG_BLACKSMITH); }

  // ---- 序列化 / 热替换（编辑器用） ----
  std::string npcsToJson() const;
  bool replaceNpcs(const Json& obj);

private:
  void addDefault(const char* npcId, const char* name, const char* desc, const char* model,
                  uint32_t tag, int shopId, int level, double wander, const char* dialogue);
  std::unordered_map<std::string, NpcDef> npcs_;
  std::unordered_set<std::string> spawned_;   // 当前已在地图上的 npcId 集合
};

} // namespace ew
