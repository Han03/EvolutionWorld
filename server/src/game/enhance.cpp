// enhance.cpp - 装备强化 + 分解系统实现（15 级强化表 + 5 档品质分解规则 + 确定性判定）
#include "enhance.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <initializer_list>

namespace ew {

static std::string readFileEnhance(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

// ---------- 查询 ----------
const EnhanceLevelDef* EnhanceSystem::levelDef(int targetLevel) const {
  if (targetLevel < 1 || targetLevel > (int)cfg_.levels.size()) return nullptr;
  return &cfg_.levels[targetLevel - 1];
}

// ---------- 核心强化 ----------
EnhanceResult EnhanceSystem::doEnhance(ItemInstance& inst, uint32_t& gold,
                                       std::unordered_map<uint32_t, uint32_t>& inv,
                                       Mulberry32& rng, bool useProtect, int forceOutcome) const {
  EnhanceResult r;
  r.goldLeft = gold;
  r.newLevel = inst.enhance;
  // 实例有效性（instId=0 视为无效；仅装备走实例化，故有效实例即装备）
  if (inst.instId == 0) { r.failCode = 7; return r; }
  // 满级校验
  if (inst.enhance >= cfg_.maxLevel) { r.failCode = 1; return r; }
  int target = inst.enhance + 1;
  const EnhanceLevelDef* ld = levelDef(target);
  if (!ld) { r.failCode = 1; return r; }   // 等级表缺失，视为满级不可强化
  // 金币校验
  if (gold < ld->goldCost) { r.failCode = 2; return r; }
  // 强化石校验
  uint32_t stoneId = ld->stoneItemId ? ld->stoneItemId : cfg_.stoneItemId;
  uint32_t haveStone = inv.count(stoneId) ? inv[stoneId] : 0;
  if (haveStone < ld->stoneCount) { r.failCode = 3; return r; }
  // 保护符校验（仅当请求使用且该级允许保护符）
  bool protect = false;
  if (useProtect && ld->canProtect) {
    uint32_t haveProt = inv.count(cfg_.protectStoneItemId) ? inv[cfg_.protectStoneItemId] : 0;
    if (haveProt < 1) { r.failCode = 4; return r; }
    protect = true;
  }
  // 扣除消耗：金币 + 强化石（+ 保护符）
  gold -= ld->goldCost;
  uint32_t stoneLeft = haveStone - ld->stoneCount;
  if (stoneLeft == 0) inv.erase(stoneId); else inv[stoneId] = stoneLeft;
  if (protect) {
    uint32_t protLeft = inv[cfg_.protectStoneItemId] - 1;
    if (protLeft == 0) inv.erase(cfg_.protectStoneItemId); else inv[cfg_.protectStoneItemId] = protLeft;
  }
  // 成功判定（forceOutcome 旁路：1 强制成功 / 2 强制失败 / 0 走 RNG）
  bool success;
  if (forceOutcome == 1) success = true;
  else if (forceOutcome == 2) success = false;
  else success = (rng.next() < (float)ld->successRate);

  r.ok = true;
  r.success = success;
  r.goldLeft = gold;
  if (success) {
    inst.enhance = (uint8_t)target;
    r.newLevel = target;
  } else {
    int nl = inst.enhance;
    // 保护符生效或该级无降级规则时不掉级；否则按 failDegrade（负数）降级，下限 0
    if (!protect && ld->failDegrade < 0) {
      nl = inst.enhance + ld->failDegrade;
      if (nl < 0) nl = 0;
    }
    inst.enhance = (uint8_t)nl;
    r.newLevel = nl;
  }
  return r;
}

// ---------- 分解：品质 → 规则（越界钳制到有效档；无规则返回 nullptr）----------
const DecomposeRule* EnhanceSystem::decomposeRule(int rarity) const {
  if (decfg_.rules.empty()) return nullptr;
  if (rarity < 0) rarity = 0;
  if (rarity >= (int)decfg_.rules.size()) rarity = (int)decfg_.rules.size() - 1;
  return &decfg_.rules[rarity];
}

// ---------- 核心分解：读 inst（enhance/locked），按 rarity 规则产出材料 + 金币 + 强化石 ----------
// rarity/basePrice 由调用方从 ItemDef 查得传入，保持与 GameData 解耦（便于单测）。
DecomposeOutput EnhanceSystem::doDecompose(const ItemInstance& inst, int rarity, uint32_t basePrice,
                                           uint32_t& gold, std::unordered_map<uint32_t, uint32_t>& inv,
                                           Mulberry32& rng) const {
  DecomposeOutput out;
  if (inst.instId == 0) { out.failCode = 2; return out; }   // 无效实例/非装备
  if (inst.locked) { out.failCode = 1; return out; }         // 锁定不可分解
  const DecomposeRule* rule = decomposeRule(rarity);
  if (!rule) { out.failCode = 3; return out; }               // 无匹配规则
  // 金币返还：basePrice × goldReturnRate（向下取整）
  uint32_t goldGain = (uint32_t)((double)basePrice * rule->goldReturnRate);
  gold += goldGain;
  out.goldGain = goldGain;
  // 强化石返还：enhanceStoneRate × enhance（向下取整）→ 高强化返还更多强化石
  uint32_t stoneGain = (uint32_t)(rule->enhanceStoneRate * (double)inst.enhance);
  if (stoneGain > 0 && decfg_.stoneItemId != 0) {
    inv[decfg_.stoneItemId] += stoneGain;
    out.items.push_back({decfg_.stoneItemId, stoneGain});
  }
  // 材料产出：按概率 + 数量区间随机
  for (const auto& res : rule->results) {
    if (res.itemId == 0) continue;
    if (res.prob < 1.0 && rng.next() >= (float)res.prob) continue;   // 概率未命中
    uint32_t cnt = res.minCount;
    if (res.maxCount > res.minCount) {
      uint32_t span = res.maxCount - res.minCount + 1;
      cnt = res.minCount + (uint32_t)(rng.next() * (float)span);
      if (cnt > res.maxCount) cnt = res.maxCount;   // 边界钳制（rng 极端值防护）
    }
    if (cnt == 0) continue;
    inv[res.itemId] += cnt;
    out.items.push_back({res.itemId, cnt});
  }
  out.ok = true;
  return out;
}

// ---------- JSON 加载（可选覆盖） ----------
bool EnhanceSystem::loadFromJson(const std::string& dir) {
  std::string sep = dir.empty() || dir.back() == '/' ? "" : "/";
  std::string content = readFileEnhance(dir + sep + "enhance.json");
  if (content.empty()) return false;
  try {
    Json obj = Json::parse(content);
    if (!replaceConfig(obj)) return false;
    fprintf(stderr, "[enhance] 加载 enhance.json: %zu 级（maxLevel=%d）\n",
            cfg_.levels.size(), cfg_.maxLevel);
    return true;
  } catch (const std::exception& e) {
    fprintf(stderr, "[enhance] enhance.json 解析失败（用默认）: %s\n", e.what());
    return false;
  }
}

// ---------- 热替换（编辑器保存完整配置） ----------
bool EnhanceSystem::replaceConfig(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  EnhanceConfig c;
  if (obj.has("maxLevel")) c.maxLevel = (int)obj.at("maxLevel").asInt();
  if (obj.has("stoneItemId")) c.stoneItemId = (uint32_t)obj.at("stoneItemId").asInt();
  if (obj.has("protectStoneItemId")) c.protectStoneItemId = (uint32_t)obj.at("protectStoneItemId").asInt();
  if (obj.has("attrPerLevelAtk")) c.attrPerLevelAtk = obj.at("attrPerLevelAtk").asNumber();
  if (obj.has("attrPerLevelDef")) c.attrPerLevelDef = obj.at("attrPerLevelDef").asNumber();
  if (obj.has("attrPerLevelHp")) c.attrPerLevelHp = obj.at("attrPerLevelHp").asNumber();
  if (obj.has("levels") && obj.at("levels").type() == Json::Type::Array) {
    for (const auto& lv : obj.at("levels").asArray()) {
      if (lv.type() != Json::Type::Object) continue;
      EnhanceLevelDef d;
      d.level = lv.has("level") ? (int)lv.at("level").asInt() : (int)c.levels.size() + 1;
      d.successRate = lv.has("successRate") ? lv.at("successRate").asNumber() : 1.0;
      d.goldCost = lv.has("goldCost") ? (uint32_t)lv.at("goldCost").asInt() : 0;
      d.stoneItemId = lv.has("stoneItemId") ? (uint32_t)lv.at("stoneItemId").asInt() : c.stoneItemId;
      d.stoneCount = lv.has("stoneCount") ? (uint32_t)lv.at("stoneCount").asInt() : 1;
      d.failDegrade = lv.has("failDegrade") ? (int)lv.at("failDegrade").asInt() : 0;
      d.canProtect = lv.has("canProtect") ? lv.at("canProtect").asBool() : false;
      c.levels.push_back(d);
    }
  }
  if (c.levels.empty()) return false;              // 无有效等级表，拒绝替换
  if (c.maxLevel <= 0) c.maxLevel = (int)c.levels.size();
  cfg_ = c;
  // 可选：分解配置（编辑器一并保存时热替换）；无 "decompose" 键则保留现有规则
  if (obj.has("decompose") && obj.at("decompose").type() == Json::Type::Object) {
    const Json& dj = obj.at("decompose");
    DecomposeConfig dc;
    dc.stoneItemId = dj.has("stoneItemId") ? (uint32_t)dj.at("stoneItemId").asInt() : c.stoneItemId;
    if (dj.has("rules") && dj.at("rules").type() == Json::Type::Array) {
      for (const auto& rj : dj.at("rules").asArray()) {
        if (rj.type() != Json::Type::Object) continue;
        DecomposeRule dr;
        dr.rarity = rj.has("rarity") ? (int)rj.at("rarity").asInt() : (int)dc.rules.size();
        dr.goldReturnRate = rj.has("goldReturnRate") ? rj.at("goldReturnRate").asNumber() : 0.3;
        dr.enhanceStoneRate = rj.has("enhanceStoneRate") ? rj.at("enhanceStoneRate").asNumber() : 0.5;
        if (rj.has("results") && rj.at("results").type() == Json::Type::Array) {
          for (const auto& xj : rj.at("results").asArray()) {
            if (xj.type() != Json::Type::Object) continue;
            DecomposeResult dres;
            dres.itemId = xj.has("itemId") ? (uint32_t)xj.at("itemId").asInt() : 0;
            dres.minCount = xj.has("minCount") ? (uint32_t)xj.at("minCount").asInt() : 1;
            dres.maxCount = xj.has("maxCount") ? (uint32_t)xj.at("maxCount").asInt() : dres.minCount;
            dres.prob = xj.has("prob") ? xj.at("prob").asNumber() : 1.0;
            if (dres.itemId != 0) dr.results.push_back(dres);
          }
        }
        dc.rules.push_back(dr);
      }
    }
    if (!dc.rules.empty()) decfg_ = dc;   // 有有效分解规则才替换
  }
  return true;
}

// ---------- 分解配置热替换（阶段7编辑器分解面板，格式同 decomposeConfigToJson）----------
bool EnhanceSystem::replaceDecomposeConfig(const Json& obj) {
  if (obj.type() != Json::Type::Object) return false;
  DecomposeConfig dc;
  dc.stoneItemId = obj.has("stoneItemId") ? (uint32_t)obj.at("stoneItemId").asInt() : cfg_.stoneItemId;
  if (obj.has("rules") && obj.at("rules").type() == Json::Type::Array) {
    for (const auto& rj : obj.at("rules").asArray()) {
      if (rj.type() != Json::Type::Object) continue;
      DecomposeRule dr;
      dr.rarity = rj.has("rarity") ? (int)rj.at("rarity").asInt() : (int)dc.rules.size();
      dr.goldReturnRate = rj.has("goldReturnRate") ? rj.at("goldReturnRate").asNumber() : 0.3;
      dr.enhanceStoneRate = rj.has("enhanceStoneRate") ? rj.at("enhanceStoneRate").asNumber() : 0.5;
      if (rj.has("results") && rj.at("results").type() == Json::Type::Array) {
        for (const auto& xj : rj.at("results").asArray()) {
          if (xj.type() != Json::Type::Object) continue;
          DecomposeResult dres;
          dres.itemId = xj.has("itemId") ? (uint32_t)xj.at("itemId").asInt() : 0;
          dres.minCount = xj.has("minCount") ? (uint32_t)xj.at("minCount").asInt() : 1;
          dres.maxCount = xj.has("maxCount") ? (uint32_t)xj.at("maxCount").asInt() : dres.minCount;
          dres.prob = xj.has("prob") ? xj.at("prob").asNumber() : 1.0;
          if (dres.itemId != 0) dr.results.push_back(dres);
        }
      }
      dc.rules.push_back(dr);
    }
  }
  if (dc.rules.empty()) return false;   // 无有效规则，拒绝替换
  decfg_ = dc;
  return true;
}

// ---------- 序列化（客户端 /api/gamedata、编辑器读取） ----------
std::string EnhanceSystem::configToJson() const {
  Json j = Json::object();
  j["maxLevel"] = (int64_t)cfg_.maxLevel;
  j["stoneItemId"] = (int64_t)cfg_.stoneItemId;
  j["protectStoneItemId"] = (int64_t)cfg_.protectStoneItemId;
  j["attrPerLevelAtk"] = cfg_.attrPerLevelAtk;
  j["attrPerLevelDef"] = cfg_.attrPerLevelDef;
  j["attrPerLevelHp"] = cfg_.attrPerLevelHp;
  Json arr = Json::array();
  for (const auto& d : cfg_.levels) {
    Json lv = Json::object();
    lv["level"] = (int64_t)d.level;
    lv["successRate"] = d.successRate;
    lv["goldCost"] = (int64_t)d.goldCost;
    lv["stoneItemId"] = (int64_t)d.stoneItemId;
    lv["stoneCount"] = (int64_t)d.stoneCount;
    lv["failDegrade"] = (int64_t)d.failDegrade;
    lv["canProtect"] = d.canProtect;
    arr.push_back(lv);
  }
  j["levels"] = arr;
  return j.dump();
}

// ---------- 分解配置序列化（客户端预览、编辑器读取）----------
std::string EnhanceSystem::decomposeConfigToJson() const {
  Json j = Json::object();
  j["stoneItemId"] = (int64_t)decfg_.stoneItemId;
  Json rules = Json::array();
  for (const auto& r : decfg_.rules) {
    Json ro = Json::object();
    ro["rarity"] = (int64_t)r.rarity;
    ro["goldReturnRate"] = r.goldReturnRate;
    ro["enhanceStoneRate"] = r.enhanceStoneRate;
    Json res = Json::array();
    for (const auto& x : r.results) {
      Json xo = Json::object();
      xo["itemId"] = (int64_t)x.itemId;
      xo["minCount"] = (int64_t)x.minCount;
      xo["maxCount"] = (int64_t)x.maxCount;
      xo["prob"] = x.prob;
      res.push_back(xo);
    }
    ro["results"] = res;
    rules.push_back(ro);
  }
  j["rules"] = rules;
  return j.dump();
}

} // namespace ew
