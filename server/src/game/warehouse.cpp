// warehouse.cpp - 仓库系统实现（多页格子 + 装备实例/堆叠物品存取 + 扩展递增费用 + 存金）
#include "warehouse.h"
#include <cstdio>
#include <cmath>
#include <fstream>
#include <sstream>
#include <algorithm>

namespace ew {

static std::string readFileWarehouse(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// ---------- 首次使用初始化（幂等）----------
void WarehouseSystem::ensureInit(WarehouseData& wh) const {
  if (wh.unlocked == 0) wh.unlocked = cfg_.initialSlots;
}

// ---------- 剩余空格子 ----------
uint32_t WarehouseSystem::freeSlots(const WarehouseData& wh) const {
  uint32_t un = wh.unlocked ? wh.unlocked : cfg_.initialSlots;
  uint32_t used = (uint32_t)wh.slots.size();
  return un > used ? un - used : 0;
}

// ---------- 当前扩展费用（1000×1.5^n，n=已扩展页数；满则 0）----------
uint32_t WarehouseSystem::expandCost(const WarehouseData& wh) const {
  if (wh.unlocked >= cfg_.maxSlots) return 0;              // 已满，不可扩展
  uint32_t base = cfg_.initialSlots ? cfg_.initialSlots : 30;
  uint32_t perPage = cfg_.slotsPerPage ? cfg_.slotsPerPage : 30;
  uint32_t unlocked = wh.unlocked ? wh.unlocked : base;    // 未初始化按初始格数
  uint32_t n = (unlocked > base) ? (unlocked - base) / perPage : 0;
  double cost = (double)cfg_.expandBaseCost * std::pow(cfg_.expandCostMul, (double)n);
  if (cost > 4.0e9) cost = 4.0e9;                          // 钳制到 uint32 安全区
  return (uint32_t)cost;
}

// ---------- 扩展：扣金币 + 解锁一页（满/金币不足拒绝）----------
uint8_t WarehouseSystem::expand(WarehouseData& wh, uint32_t& playerGold) const {
  ensureInit(wh);
  if (wh.unlocked >= cfg_.maxSlots) return WH_MAX_SLOTS;   // 满 150 格拒绝扩展
  uint32_t cost = expandCost(wh);
  if (cost == 0) return WH_MAX_SLOTS;
  if (playerGold < cost) return WH_NO_GOLD;                // 金币不足
  playerGold -= cost;
  wh.unlocked += cfg_.slotsPerPage;
  if (wh.unlocked > cfg_.maxSlots) wh.unlocked = cfg_.maxSlots;
  return WH_OK;
}

// ---------- 存入：金币(itemId=0) / 装备实例 / 堆叠物品(合并同 itemId) ----------
uint8_t WarehouseSystem::deposit(WarehouseData& wh, uint32_t& playerGold, bool isInstance, uint64_t instId,
                                 uint32_t itemId, uint32_t count, std::vector<ItemInstance>& equipBag,
                                 std::unordered_map<uint32_t, uint32_t>& inv) const {
  ensureInit(wh);
  // (1) 存金：itemId==0 && !isInstance
  if (!isInstance && itemId == 0) {
    if (count == 0) return WH_BAD_COUNT;
    if (playerGold < count) return WH_NO_GOLD;
    if ((uint64_t)wh.gold + count > cfg_.maxGold) return WH_GOLD_LIMIT;
    playerGold -= count;
    wh.gold += count;
    return WH_OK;
  }
  // (2) 装备实例存入：从 equipBag 移除，保留 enhance/locked
  if (isInstance) {
    if (instId == 0) return WH_NOT_FOUND;
    size_t idx = (size_t)-1;
    for (size_t i = 0; i < equipBag.size(); i++)
      if (equipBag[i].instId == instId) { idx = i; break; }
    if (idx == (size_t)-1) return WH_NOT_FOUND;            // 背包无此实例
    if (wh.slots.size() >= wh.unlocked) return WH_FULL;    // 仓库满
    const ItemInstance& ins = equipBag[idx];
    WarehouseSlot s;
    s.isInstance = true; s.instId = ins.instId; s.itemId = ins.itemId;
    s.enhance = ins.enhance; s.locked = ins.locked; s.count = 1;
    wh.slots.push_back(s);
    equipBag.erase(equipBag.begin() + (ptrdiff_t)idx);
    return WH_OK;
  }
  // (3) 堆叠物品存入
  if (itemId == 0 || count == 0) return WH_BAD_COUNT;
  auto it = inv.find(itemId);
  if (it == inv.end() || it->second < count) return WH_NOT_FOUND;   // 持有不足
  // 合并到已有同 itemId 堆叠格子（验收标准「堆叠物品正确合并」）
  for (auto& s : wh.slots) {
    if (!s.isInstance && s.itemId == itemId) {
      s.count += count;
      it->second -= count;
      if (it->second == 0) inv.erase(it);
      return WH_OK;
    }
  }
  // 无同格子：需空格
  if (wh.slots.size() >= wh.unlocked) return WH_FULL;
  WarehouseSlot s;
  s.isInstance = false; s.itemId = itemId; s.count = count;
  wh.slots.push_back(s);
  it->second -= count;
  if (it->second == 0) inv.erase(it);
  return WH_OK;
}

// ---------- 取出：金币(itemId=0) / 装备实例 / 堆叠物品 ----------
uint8_t WarehouseSystem::withdraw(WarehouseData& wh, uint32_t& playerGold, bool isInstance, uint64_t instId,
                                  uint32_t itemId, uint32_t count, std::vector<ItemInstance>& equipBag,
                                  std::unordered_map<uint32_t, uint32_t>& inv) const {
  ensureInit(wh);
  // (1) 取金：itemId==0 && !isInstance
  if (!isInstance && itemId == 0) {
    if (count == 0) return WH_BAD_COUNT;
    if (wh.gold < count) return WH_NO_GOLD;
    wh.gold -= count;
    playerGold += count;
    return WH_OK;
  }
  // (2) 装备实例取出：回 equipBag，原样恢复 enhance/locked（强化等级保留）
  if (isInstance) {
    if (instId == 0) return WH_NOT_FOUND;
    size_t idx = (size_t)-1;
    for (size_t i = 0; i < wh.slots.size(); i++)
      if (wh.slots[i].isInstance && wh.slots[i].instId == instId) { idx = i; break; }
    if (idx == (size_t)-1) return WH_NOT_FOUND;            // 仓库无此实例
    const WarehouseSlot& s = wh.slots[idx];
    ItemInstance ins;
    ins.instId = s.instId; ins.itemId = s.itemId; ins.enhance = s.enhance; ins.locked = s.locked;
    equipBag.push_back(ins);
    wh.slots.erase(wh.slots.begin() + (ptrdiff_t)idx);
    return WH_OK;
  }
  // (3) 堆叠物品取出：回 inv（最多取格子现有量）
  if (itemId == 0 || count == 0) return WH_BAD_COUNT;
  for (size_t i = 0; i < wh.slots.size(); i++) {
    WarehouseSlot& s = wh.slots[i];
    if (s.isInstance || s.itemId != itemId) continue;
    uint32_t take = (count >= s.count) ? s.count : count;
    inv[itemId] += take;
    s.count -= take;
    if (s.count == 0) wh.slots.erase(wh.slots.begin() + (ptrdiff_t)i);
    return WH_OK;
  }
  return WH_NOT_FOUND;                                     // 仓库无此堆叠物品
}

// ---------- 锁定/解锁格子（仅装备实例）----------
uint8_t WarehouseSystem::lock(WarehouseData& wh, uint32_t slotIndex, bool doLock) const {
  if (slotIndex >= wh.slots.size()) return WH_NOT_FOUND;
  WarehouseSlot& s = wh.slots[slotIndex];
  if (!s.isInstance) return WH_NOT_FOUND;                  // 仅装备实例可锁定
  s.locked = doLock;
  return WH_OK;
}

// ---------- 整理：装备实例在前，堆叠在后，各自按 itemId 升序（稳定）----------
void WarehouseSystem::sort(WarehouseData& wh) const {
  std::stable_sort(wh.slots.begin(), wh.slots.end(), [](const WarehouseSlot& a, const WarehouseSlot& b) {
    if (a.isInstance != b.isInstance) return a.isInstance;  // 装备在前
    return a.itemId < b.itemId;
  });
}

// ---------- JSON 加载（可选覆盖配置）----------
bool WarehouseSystem::loadFromJson(const std::string& dir) {
  std::string sep = dir.empty() || dir.back() == '/' ? "" : "/";
  std::string content = readFileWarehouse(dir + sep + "warehouse.json");
  if (content.empty()) return false;
  try {
    Json obj = Json::parse(content);
    if (!replaceConfig(obj)) return false;
    fprintf(stderr, "[warehouse] 加载 warehouse.json: 初始%u格/每页%u/最大%u格\n",
            cfg_.initialSlots, cfg_.slotsPerPage, cfg_.maxSlots);
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[warehouse] warehouse.json 解析失败（用默认）: %s\n", e.what());
    return false;
  }
}

// ---------- 热替换（编辑器保存配置）----------
bool WarehouseSystem::replaceConfig(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  WarehouseConfig c = cfg_;   // 基于当前，缺失字段保留
  if (obj.has("initialSlots")) c.initialSlots = (uint32_t)obj.at("initialSlots").asInt();
  if (obj.has("slotsPerPage")) c.slotsPerPage = (uint32_t)obj.at("slotsPerPage").asInt();
  if (obj.has("maxSlots")) c.maxSlots = (uint32_t)obj.at("maxSlots").asInt();
  if (obj.has("expandBaseCost")) c.expandBaseCost = (uint32_t)obj.at("expandBaseCost").asInt();
  if (obj.has("expandCostMul")) c.expandCostMul = obj.at("expandCostMul").asNumber();
  if (obj.has("maxGold")) c.maxGold = (uint32_t)obj.at("maxGold").asInt();
  // 合法性校验（避免除零/倒挂）
  if (c.initialSlots == 0 || c.slotsPerPage == 0 || c.maxSlots < c.initialSlots) return false;
  cfg_ = c;
  return true;
}

// ---------- 序列化配置（客户端 /api/gamedata、编辑器读取）----------
std::string WarehouseSystem::configToJson() const {
  Json o = Json::object();
  o["initialSlots"] = (int64_t)cfg_.initialSlots;
  o["slotsPerPage"] = (int64_t)cfg_.slotsPerPage;
  o["maxSlots"] = (int64_t)cfg_.maxSlots;
  o["expandBaseCost"] = (int64_t)cfg_.expandBaseCost;
  o["expandCostMul"] = cfg_.expandCostMul;
  o["maxGold"] = (int64_t)cfg_.maxGold;
  return o.dump();
}

// ---------- 持久化：玩家仓库数据 → JSON 字符串 ----------
std::string WarehouseSystem::serialize(const WarehouseData& wh) const {
  Json o = Json::object();
  o["gold"] = (int64_t)wh.gold;
  o["unlocked"] = (int64_t)wh.unlocked;
  Json arr = Json::array();
  for (const auto& s : wh.slots) {
    Json so = Json::object();
    so["isInstance"] = s.isInstance;
    so["instId"] = (int64_t)s.instId;
    so["itemId"] = (int64_t)s.itemId;
    so["enhance"] = (int64_t)s.enhance;
    so["locked"] = s.locked;
    so["count"] = (int64_t)s.count;
    arr.push_back(so);
  }
  o["slots"] = arr;
  return o.dump();
}

// ---------- 持久化：JSON 字符串 → 玩家仓库数据 ----------
bool WarehouseSystem::deserialize(const std::string& json, WarehouseData& wh) const {
  if (json.empty()) return false;
  try {
    Json o = Json::parse(json);
    if (o.type() != Json::Type::Object) return false;
    wh.gold = o.has("gold") ? (uint32_t)o.at("gold").asInt() : 0;
    wh.unlocked = o.has("unlocked") ? (uint32_t)o.at("unlocked").asInt() : 0;
    wh.slots.clear();
    if (o.has("slots") && o.at("slots").type() == Json::Type::Array) {
      for (const auto& sj : o.at("slots").asArray()) {
        if (sj.type() != Json::Type::Object) continue;
        WarehouseSlot s;
        s.isInstance = sj.has("isInstance") && sj.at("isInstance").type() == Json::Type::Bool ? sj.at("isInstance").asBool() : false;
        s.instId = sj.has("instId") ? (uint64_t)sj.at("instId").asInt() : 0;
        s.itemId = sj.has("itemId") ? (uint32_t)sj.at("itemId").asInt() : 0;
        s.enhance = sj.has("enhance") ? (uint8_t)sj.at("enhance").asInt() : 0;
        s.locked = sj.has("locked") && sj.at("locked").type() == Json::Type::Bool ? sj.at("locked").asBool() : false;
        s.count = sj.has("count") ? (uint32_t)sj.at("count").asInt() : 0;
        // 有效性：装备需 instId，堆叠需 itemId
        if (s.isInstance ? (s.instId != 0) : (s.itemId != 0)) wh.slots.push_back(s);
      }
    }
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[warehouse] 仓库数据解析失败: %s\n", e.what());
    return false;
  }
}

} // namespace ew
