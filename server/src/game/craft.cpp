// craft.cpp - 物品合成系统实现（内置配方表 + NPC/等级/隐藏过滤 + 权威扣除产出）
#include "craft.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <initializer_list>

namespace ew {

static std::string readFileCraft(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// ---------- 查询：recipeId → 配方 ----------
const CraftRecipe* CraftSystem::recipe(uint32_t recipeId) const {
  for (const auto& r : recipes_) if (r.recipeId == recipeId) return &r;
  return nullptr;
}

// ---------- 过滤：NPC 标签匹配 + 等级达标 + 非隐藏 ----------
std::vector<const CraftRecipe*> CraftSystem::availableRecipes(uint32_t npcTagMask, int playerLevel) const {
  std::vector<const CraftRecipe*> out;
  for (const auto& r : recipes_) {
    if (r.hidden) continue;                                   // 隐藏配方不显示
    if ((npcTagMask & r.npcTag) != r.npcTag) continue;        // NPC 标签不符
    if (playerLevel < r.levelReq) continue;                   // 等级不足不显示
    out.push_back(&r);
  }
  return out;
}

// ---------- 校验（不扣除）：返回 failCode（0=可以合成）----------
int CraftSystem::canCraft(const CraftRecipe& r, int playerLevel, uint32_t gold,
                          const std::unordered_map<uint32_t, uint32_t>& inv, uint32_t count) const {
  if (count == 0) count = 1;
  if (playerLevel < r.levelReq) return 2;                     // 等级不足
  // 材料校验（需求 × count）
  for (const auto& m : r.materials) {
    if (m.itemId == 0) continue;
    uint64_t need = (uint64_t)m.count * count;
    auto it = inv.find(m.itemId);
    uint64_t have = (it != inv.end()) ? it->second : 0;
    if (have < need) return 3;                                // 材料不足
  }
  // 金币校验（消耗 × count）
  if ((uint64_t)gold < (uint64_t)r.goldCost * count) return 4; // 金币不足
  return 0;
}

// ---------- 核心合成：校验 → 扣材料+金币 → 产出 ----------
// resultIsEquip 由调用方从 ItemDef 查得传入（装备→isInstance，instId 由 world 分配；堆叠→写 inv）。
CraftOutput CraftSystem::doCraft(const CraftRecipe& r, int playerLevel, bool resultIsEquip,
                                 uint32_t& gold, std::unordered_map<uint32_t, uint32_t>& inv,
                                 uint32_t count) const {
  CraftOutput out;
  out.recipeId = r.recipeId;
  out.resultItemId = r.resultItemId;
  // 装备产出恒为单件（S2C_CRAFT 仅回一个 instId）；堆叠产出支持批量
  if (count == 0) count = 1;
  if (resultIsEquip) count = 1;
  // 统一校验（等级/材料/金币）
  int fc = canCraft(r, playerLevel, gold, inv, count);
  if (fc != 0) { out.failCode = fc; return out; }
  // 扣除材料（需求 × count）
  for (const auto& m : r.materials) {
    if (m.itemId == 0) continue;
    uint32_t need = m.count * count;
    uint32_t left = inv[m.itemId] - need;
    if (left == 0) inv.erase(m.itemId); else inv[m.itemId] = left;
  }
  // 扣除金币（消耗 × count）
  uint32_t goldSpend = r.goldCost * count;
  gold -= goldSpend;
  out.goldCost = goldSpend;
  // 产出
  out.resultCount = r.resultCount * count;
  out.ok = true;
  if (resultIsEquip) {
    out.isInstance = true;      // instId 由 world 分配（giveEquipInstance）
    out.resultCount = r.resultCount;   // 装备恒为配方定义数量（通常 1）
  } else {
    out.isInstance = false;
    inv[r.resultItemId] += out.resultCount;   // 堆叠产出直接入背包
  }
  return out;
}

// ---------- JSON 加载（可选覆盖）----------
bool CraftSystem::loadFromJson(const std::string& dir) {
  std::string sep = dir.empty() || dir.back() == '/' ? "" : "/";
  std::string content = readFileCraft(dir + sep + "craft.json");
  if (content.empty()) return false;
  try {
    Json obj = Json::parse(content);
    if (!replaceConfig(obj)) return false;
    fprintf(stderr, "[craft] 加载 craft.json: %zu 个配方\n", recipes_.size());
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[craft] craft.json 解析失败（用默认）: %s\n", e.what());
    return false;
  }
}

// ---------- 热替换（编辑器保存完整配置）----------
bool CraftSystem::replaceConfig(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  if (!obj.has("recipes") || obj.at("recipes").type() != Json::Type::Array) return false;
  std::vector<CraftRecipe> rs;
  for (const auto& rj : obj.at("recipes").asArray()) {
    if (rj.type() != Json::Type::Object) continue;
    CraftRecipe r;
    r.recipeId = rj.has("recipeId") ? (uint32_t)rj.at("recipeId").asInt() : 0;
    if (r.recipeId == 0) continue;
    r.name = rj.has("name") ? rj.at("name").asString() : "";
    r.npcTag = rj.has("npcTag") ? (uint32_t)rj.at("npcTag").asInt() : (uint32_t)NPC_TAG_CRAFT;
    r.resultItemId = rj.has("resultItemId") ? (uint32_t)rj.at("resultItemId").asInt() : 0;
    r.resultCount = rj.has("resultCount") ? (uint32_t)rj.at("resultCount").asInt() : 1;
    r.goldCost = rj.has("goldCost") ? (uint32_t)rj.at("goldCost").asInt() : 0;
    r.levelReq = rj.has("levelReq") ? (int)rj.at("levelReq").asInt() : 1;
    r.hidden = rj.has("hidden") ? rj.at("hidden").asBool() : false;
    if (rj.has("materials") && rj.at("materials").type() == Json::Type::Array) {
      for (const auto& mj : rj.at("materials").asArray()) {
        if (mj.type() != Json::Type::Object) continue;
        CraftMaterial m;
        m.itemId = mj.has("itemId") ? (uint32_t)mj.at("itemId").asInt() : 0;
        m.count = mj.has("count") ? (uint32_t)mj.at("count").asInt() : 1;
        if (m.itemId != 0) r.materials.push_back(m);
      }
    }
    if (r.resultItemId != 0) rs.push_back(r);
  }
  if (rs.empty()) return false;   // 无有效配方，拒绝替换
  recipes_ = rs;
  return true;
}

// ---------- 序列化（客户端 /api/gamedata、编辑器读取）----------
std::string CraftSystem::configToJson() const {
  Json j = Json::object();
  Json arr = Json::array();
  for (const auto& r : recipes_) {
    Json ro = Json::object();
    ro["recipeId"] = (int64_t)r.recipeId;
    ro["name"] = r.name;
    ro["npcTag"] = (int64_t)r.npcTag;
    ro["resultItemId"] = (int64_t)r.resultItemId;
    ro["resultCount"] = (int64_t)r.resultCount;
    ro["goldCost"] = (int64_t)r.goldCost;
    ro["levelReq"] = (int64_t)r.levelReq;
    ro["hidden"] = r.hidden;
    Json mats = Json::array();
    for (const auto& m : r.materials) {
      Json mo = Json::object();
      mo["itemId"] = (int64_t)m.itemId;
      mo["count"] = (int64_t)m.count;
      mats.push_back(mo);
    }
    ro["materials"] = mats;
    arr.push_back(ro);
  }
  j["recipes"] = arr;
  return j.dump();
}

} // namespace ew
