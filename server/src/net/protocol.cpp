// protocol.cpp - 二进制协议编解码实现
#include "protocol.h"
#include "config.h"
#include "game/items.h"
#include <cstring>
#include <cmath>
namespace ew {
namespace proto {
// ---------- Writer ----------
void Writer::u8(uint8_t v) { buf_.push_back((char)v); }
void Writer::u16(uint16_t v) {
  buf_.push_back((char)(v & 0xFF));
  buf_.push_back((char)((v >> 8) & 0xFF));
}
void Writer::u32(uint32_t v) {
  for (int i = 0; i < 4; i++) buf_.push_back((char)((v >> (8 * i)) & 0xFF));
}
void Writer::u64(uint64_t v) {
  for (int i = 0; i < 8; i++) buf_.push_back((char)((v >> (8 * i)) & 0xFF));
}
void Writer::i16(int16_t v) { u16((uint16_t)v); }
void Writer::i32(int32_t v) { u32((uint32_t)v); }
void Writer::f32(float v) {
  uint32_t bits;
  memcpy(&bits, &v, 4);
  u32(bits);
}
void Writer::raw(const void* p, size_t n) {
  buf_.append((const char*)p, n);
}
void Writer::str(const std::string& s) {
  u8((uint8_t)(s.size() & 0xFF));
  raw(s.data(), s.size());
}
// ---------- Reader ----------
bool Reader::u8(uint8_t& v) {
  if (!remaining(1)) return false;
  v = (uint8_t)*p_++;
  return true;
}
bool Reader::u16(uint16_t& v) {
  if (!remaining(2)) return false;
  v = (uint16_t)p_[0] | ((uint16_t)p_[1] << 8);
  p_ += 2;
  return true;
}
bool Reader::u32(uint32_t& v) {
  if (!remaining(4)) return false;
  v = 0;
  for (int i = 0; i < 4; i++) v |= ((uint32_t)p_[i]) << (8 * i);
  p_ += 4;
  return true;
}
bool Reader::u64(uint64_t& v) {
  if (!remaining(8)) return false;
  v = 0;
  for (int i = 0; i < 8; i++) v |= ((uint64_t)(uint8_t)p_[i]) << (8 * i);
  p_ += 8;
  return true;
}
bool Reader::i16(int16_t& v) {
  uint16_t u;
  if (!u16(u)) return false;
  v = (int16_t)u;
  return true;
}
bool Reader::i32(int32_t& v) {
  uint32_t u;
  if (!u32(u)) return false;
  v = (int32_t)u;
  return true;
}
bool Reader::f32(float& v) {
  uint32_t u;
  if (!u32(u)) return false;
  memcpy(&v, &u, 4);
  return true;
}
bool Reader::raw(void* out, size_t n) {
  if (!remaining(n)) return false;
  memcpy(out, p_, n);
  p_ += n;
  return true;
}
bool Reader::str(std::string& s) {
  uint8_t len;
  if (!u8(len)) return false;
  if (!remaining(len)) return false;
  s.assign((const char*)p_, len);
  p_ += len;
  return true;
}
// ---------- 帧 ----------
std::string frame(uint8_t type, const std::string& payload, uint8_t flags, uint16_t seq) {
  std::string f;
  f.reserve(kHeaderSize + payload.size());
  f.push_back((char)kMagic0);
  f.push_back((char)kMagic1);
  f.push_back((char)kVersion);
  f.push_back((char)type);
  f.push_back((char)flags);
  f.push_back((char)(seq & 0xFF));
  f.push_back((char)((seq >> 8) & 0xFF));
  size_t len = payload.size();
  f.push_back((char)(len & 0xFF));
  f.push_back((char)((len >> 8) & 0xFF));
  f.append(payload);
  return f;
}
bool parseFrame(const std::string& data, size_t offset, size_t& consumed, Frame& f) {
  if (data.size() - offset < kHeaderSize) return false;
  const uint8_t* d = (const uint8_t*)data.data() + offset;
  if (d[0] != kMagic0 || d[1] != kMagic1) return false;
  f.type = d[3];
  f.flags = d[4];
  f.seq = (uint16_t)d[5] | ((uint16_t)d[6] << 8);
  size_t len = (size_t)d[7] | ((size_t)d[8] << 8);
  if (data.size() - offset < kHeaderSize + len) return false;
  f.payload.assign((const char*)d + kHeaderSize, len);
  consumed = offset + kHeaderSize + len;
  return true;
}
// ---------- 实体全量 ----------
void writeEntityFull(Writer& w, const Entity& e, const Vec3& ref) {
  w.u32((uint32_t)e.wid);
  switch (e.kind) {
    case EntityKind::Player: w.u8(KIND_PLAYER); break;
    case EntityKind::Monster: w.u8(KIND_MONSTER); break;
    case EntityKind::Item: w.u8(KIND_ITEM); break;
    default: w.u8(KIND_NPC); break;
  }
  w.u8(entityState(e));
  w.i16(qRel(e.pos.x, ref.x));
  w.i16(qRel(e.pos.y, ref.y));
  w.i16(qRel(e.pos.z, ref.z));
  w.i16(qVel(e.vel.x));
  w.i16(qVel(e.vel.z));
  if (e.kind == EntityKind::Item) {
    // 掉落物：itemId(0=纯金币) + gold 数量 + 装备实例（instId!=0 为装备，携带强化）
    w.u32(e.dropItemId);
    w.u32(e.dropGold);
    w.u64(e.dropInst.instId);
    w.u8(e.dropInst.enhance);
  } else if (e.kind == EntityKind::Player) {
    w.str(e.username);
  } else {
    w.str(e.name.empty() ? (e.kind == EntityKind::Monster ? "Monster" : "NPC") : e.name);
    // AI 意图块（怪物/NPC/精英）：半径 + aiState + 目标速度 + 速度倍率
    // 客户端据此做确定性外推（与服务端同款物理），位置/瞬时速度仍走上方字段
    w.u16((uint16_t)std::lround(e.radius * 100.0)); // 0.01m
    w.u8(e.ai.aiState);
    w.i16(qVel(e.ai.targetVX));
    w.i16(qVel(e.ai.targetVZ));
    w.u8((uint8_t)std::lround(e.moveScale() * 100.0)); // 0-100%
    // 怪物生命值（客户端仇恨血条渲染）+ 精英标志 + 无敌标志（恢复态免疫伤害，autobot 据此跳过）
    if (e.kind == EntityKind::Monster) {
      w.u16((uint16_t)std::lround(e.hp));
      w.u16((uint16_t)std::lround(e.maxHp));
      w.u8(e.isElite ? 1 : 0);
      w.u8(e.ai.invincible ? 1 : 0);
    }
    // NPC 插件：NPC 实体额外广播 npcId + npcTag（客户端据此渲染交互菜单）
    if (e.kind == EntityKind::Npc) {
      w.str(e.npcId);
      w.u32(e.npcTag);
    }
  }
}
// 实体列表 + 服务端参考坐标（客户端用此 ref 解码相对坐标，消除一 tick 预测偏差）
static std::string entityListToPayload(const std::vector<const Entity*>& ents, const Vec3& ref) {
  Writer w;
  // 服务端参考坐标：客户端据此解码相对坐标，而非使用客户端预测位置（两者差 1 tick）
  w.i32(qAbs(ref.x));
  w.i16(qAbs(ref.y));
  w.i32(qAbs(ref.z));
  w.u16((uint16_t)ents.size());
  for (const Entity* e : ents) writeEntityFull(w, *e, ref);
  return w.data();
}
std::string hello(const Config& cfg, const Entity& self) {
  Writer w;
  w.i32(cfg.worldSeed);
  w.f32(cfg.viewRangeM);
  w.f32(cfg.chunkSizeM);
  w.f32(cfg.tickRateHz);
  // 自身绝对位置（客户端初始化预测器必需；其余字段用相对自身 = (0,0,0) 编码）
  w.i32(qAbs(self.pos.x));
  w.i16(qAbs(self.pos.y));
  w.i32(qAbs(self.pos.z));
  writeEntityFull(w, self, self.pos);
  return frame(S2C_HELLO, w.data());
}
std::string snapshot(uint32_t tick, const std::vector<const Entity*>& ents, const Vec3& ref) {
  Writer w;
  w.u32(tick);
  // 服务端参考坐标（与 ENTER/UPDATE 一致）
  w.i32(qAbs(ref.x));
  w.i16(qAbs(ref.y));
  w.i32(qAbs(ref.z));
  w.u16((uint16_t)ents.size());
  for (const Entity* e : ents) writeEntityFull(w, *e, ref);
  return frame(S2C_SNAPSHOT, w.data());
}
std::string enter(const std::vector<const Entity*>& ents, const Vec3& ref) {
  return frame(S2C_ENTER, entityListToPayload(ents, ref));
}
std::string leave(const std::vector<uint32_t>& wids) {
  Writer w;
  w.u16((uint16_t)wids.size());
  for (uint32_t id : wids) w.u32(id);
  return frame(S2C_LEAVE, w.data());
}
std::string update(const std::vector<uint32_t>& wids,
                   const std::vector<uint8_t>& masks,
                   const std::vector<const Entity*>& ents,
                   const Vec3& ref) {
  Writer w;
  // 服务端参考坐标：客户端据此解码相对坐标，消除一 tick 预测偏差
  w.i32(qAbs(ref.x));
  w.i16(qAbs(ref.y));
  w.i32(qAbs(ref.z));
  w.u16((uint16_t)wids.size());
  for (size_t i = 0; i < wids.size(); i++) {
    w.u32(wids[i]);
    w.u8(masks[i]);
    const Entity& e = *ents[i];
    if (masks[i] & M_POS) {
      w.i16(qRel(e.pos.x, ref.x));
      w.i16(qRel(e.pos.y, ref.y));
      w.i16(qRel(e.pos.z, ref.z));
    }
    if (masks[i] & M_VEL) {
      w.i16(qVel(e.vel.x));
      w.i16(qVel(e.vel.z));
    }
    if (masks[i] & M_STATE) w.u8(entityState(e));
    if (masks[i] & M_INTENT) {
      w.u8(e.ai.aiState);
      w.i16(qVel(e.ai.targetVX));
      w.i16(qVel(e.ai.targetVZ));
      w.u8((uint8_t)std::lround(e.moveScale() * 100.0));
      // 生命值（与 writeEntityFull 对齐；客户端 parseS2C UPDATE 分支无条件读取，
      // 因此 Monster/NPC 均须写入，否则 NPC INTENT 变化时客户端 short read）
      w.u16((uint16_t)std::lround(e.hp));
      w.u16((uint16_t)std::lround(e.maxHp));
      // 无敌标志（与 writeEntityFull 对齐；仅怪物携带，NPC 固定写 0 保字节对齐）
      w.u8(e.kind == EntityKind::Monster && e.ai.invincible ? 1 : 0);
    }
  }
  return frame(S2C_UPDATE, w.data());
}
std::string selfCorrection(const std::string& reason, const Entity& p, uint32_t tick) {
  Writer w;
  w.str(reason);
  w.i32(qAbs(p.pos.x));
  w.i16(qAbs(p.pos.y));
  w.i32(qAbs(p.pos.z));
  w.u32(tick);
  return frame(S2C_SELF, w.data());
}
std::string ping(uint32_t ts) {
  Writer w;
  w.u32(ts);
  return frame(S2C_PING, w.data(), FLAG_ACK);
}
std::string kick(const std::string& reason) {
  Writer w;
  w.str(reason);
  return frame(S2C_KICK, w.data());
}
std::string error(uint8_t code, const std::string& msg) {
  Writer w;
  w.u8(code);
  w.str(msg);
  return frame(S2C_ERROR, w.data());
}
// ---------- 物品/属性/商店 编码 ----------
// 商店列表帧（阶段1扩展）：shopId + 名称/描述 + 类型/货币 + 商品条目（含折扣/限购/分类/刷新/回收）
std::string shopFrame(const ::ew::ShopDef& shop, const Entity* buyer) {
  Writer w;
  w.u32(shop.shopId);
  w.str(shop.name);
  w.str(shop.desc);
  w.u8(shop.shopType);
  w.u32(shop.currencyItemId);
  w.u16((uint16_t)shop.entries.size());
  for (const auto& e : shop.entries) {
    w.u32(e.itemId);
    w.u32(e.price);
    w.u32(e.discountPrice);
    w.u16((uint16_t)e.stock);
    w.u32(e.buyLimit);
    w.u8(e.category);
    w.u8(e.refreshType);
    w.u32(e.sellPrice);
    // 已购数量（限购进度）：仅 buyLimit>0 且 buyer 非空时查表，key=(shopId<<32|itemId)
    uint32_t bought = 0;
    if (buyer && e.buyLimit > 0) {
      uint64_t key = ((uint64_t)shop.shopId << 32) | (uint64_t)e.itemId;
      auto it = buyer->pl.shopBuyCount.find(key);
      if (it != buyer->pl.shopBuyCount.end()) bought = it->second;
    }
    w.u32(bought);
  }
  return frame(S2C_SHOP, w.data());
}
// 出售回收结果帧（阶段1）：ok + 获得金币
std::string sellResultFrame(bool ok, uint32_t goldGain) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u32(goldGain);
  return frame(S2C_SELL_RESULT, w.data());
}
// 装备强化结果帧（阶段2）：ok + failCode + 实例 + 新等级 + 成功标志 + 剩余金币
std::string enhanceFrame(bool ok, uint8_t failCode, uint64_t instId, uint8_t newLevel, bool success, uint32_t goldLeft) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u8(failCode);
  w.u64(instId);
  w.u8(newLevel);
  w.u8(success ? 1 : 0);
  w.u32(goldLeft);
  return frame(S2C_ENHANCE, w.data());
}
// 装备分解结果帧（阶段3）：ok + failCode + 产出清单(itemId,count) + 返还金币
std::string decomposeFrame(bool ok, uint8_t failCode, const std::vector<std::pair<uint32_t, uint32_t>>& items, uint32_t goldGain) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u8(failCode);
  w.u16((uint16_t)items.size());
  for (const auto& it : items) {
    w.u32(it.first);
    w.u16((uint16_t)it.second);
  }
  w.u32(goldGain);
  return frame(S2C_DECOMPOSE, w.data());
}
// 合成配方列表帧（阶段4）：u16 count, [u32 recipeId]...
std::string craftListFrame(const std::vector<uint32_t>& recipeIds) {
  Writer w;
  w.u16((uint16_t)recipeIds.size());
  for (uint32_t id : recipeIds) w.u32(id);
  return frame(S2C_CRAFT_LIST, w.data());
}
// 合成结果帧（阶段4）：u8 ok, u8 failCode, u32 recipeId, u32 resultItemId, u16 resultCount, u8 isInstance, u64 instId
std::string craftFrame(bool ok, uint8_t failCode, uint32_t recipeId, uint32_t resultItemId, uint16_t resultCount, bool isInstance, uint64_t instId) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u8(failCode);
  w.u32(recipeId);
  w.u32(resultItemId);
  w.u16(resultCount);
  w.u8(isInstance ? 1 : 0);
  w.u64(instId);
  return frame(S2C_CRAFT, w.data());
}
// 仓库全量帧（阶段5）：u32 gold, u32 unlocked, u16 slotCount, [u8 isInstance, u64 instId, u32 itemId, u8 enhance, u8 locked, u32 count]...
std::string warehouseFrame(const WarehouseData& wh) {
  Writer w;
  w.u32(wh.gold);
  w.u32(wh.unlocked);
  w.u16((uint16_t)wh.slots.size());
  for (const auto& s : wh.slots) {
    w.u8(s.isInstance ? 1 : 0);
    w.u64(s.instId);
    w.u32(s.itemId);
    w.u8(s.enhance);
    w.u8(s.locked ? 1 : 0);
    w.u32(s.count);
  }
  return frame(S2C_WAREHOUSE, w.data());
}
// 仓库操作结果帧（阶段5）：u8 op, u8 code
std::string warehouseResultFrame(uint8_t op, uint8_t code) {
  Writer w;
  w.u8(op);
  w.u8(code);
  return frame(S2C_WAREHOUSE_RESULT, w.data());
}
// 背包/装备/金币全量帧（服务端权威，客户端据此重建）
// 装备实例化格式：gold + 已穿戴实例 + 背包装备实例 + 堆叠物品
std::string inventoryFrame(const Entity& p) {
  Writer w;
  w.u32(p.pl.gold);
  // 已穿戴装备（实例）：slot + instId + itemId + enhance
  w.u8((uint8_t)p.pl.equip.size());
  for (int i = 0; i < (int)p.pl.equip.size(); i++) {
    const ItemInstance& ins = p.pl.equip[i];
    w.u8((uint8_t)(::ew::GameData::indexSlot(i))); // 槽位值 1..6
    w.u64(ins.instId);
    w.u32(ins.itemId);
    w.u8(ins.enhance);
  }
  // 背包装备实例：instId + itemId + enhance + locked
  w.u16((uint16_t)p.pl.equipBag.size());
  for (const auto& ins : p.pl.equipBag) {
    w.u64(ins.instId);
    w.u32(ins.itemId);
    w.u8(ins.enhance);
    w.u8(ins.locked ? 1 : 0);
  }
  // 堆叠物品：itemId + count
  w.u16((uint16_t)p.pl.inventory.size());
  for (const auto& [id, cnt] : p.pl.inventory) {
    w.u32(id);
    w.u16((uint16_t)cnt);
  }
  return frame(S2C_INVENTORY, w.data());
}
// 自身属性帧（血量/蓝量/攻击/防御/等级/经验）
std::string statsFrame(const Entity& p) {
  Writer w;
  w.u32((uint32_t)p.maxHp);
  w.u32((uint32_t)p.maxMp);
  w.u32((uint32_t)p.attack);
  w.u32((uint32_t)p.defense);
  w.u32((uint32_t)p.hp);
  w.u32((uint32_t)p.mp);
  w.u32((uint32_t)p.level);            // 等级
  w.u32((uint32_t)p.pl.exp);           // 当前级已累计经验
  w.u32(playerExpToNext(p.level));     // 升下一级所需经验
  return frame(S2C_STATS, w.data());
}
// 拾取反馈帧
std::string lootFrame(bool ok, uint32_t itemId, uint16_t count, uint32_t gold) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u32(itemId);
  w.u16(count);
  w.u32(gold);
  return frame(S2C_LOOT, w.data());
}
// 技能施放反馈帧（success + skillId + 目标 wid + 落点 + 施放时间 castTimeMs）
std::string skillCastFrame(bool ok, uint32_t skillId, uint32_t targetWid, int32_t x, int32_t z, uint16_t castTimeMs) {
  Writer w;
  w.u8(ok ? 1 : 0);
  w.u32(skillId);
  w.u32(targetWid);
  w.i32(x);
  w.i32(z);
  w.u16(castTimeMs);
  return frame(S2C_SKILL_CAST, w.data());
}
// 控制台命令结果帧（逐行 utf-8 文本）
std::string consoleFrame(const std::string& text) {
  Writer w;
  w.str(text);
  return frame(S2C_CONSOLE, w.data());
}
// 地形变更通知帧（零 payload）：仅告知在线客户端「地形数据已变，请重拉」。
// 客户端收到后重走 /api/terrain/mask + /api/terrain/edit，并自行做地形缓存/网格/小地图失效。
std::string terrainDirtyFrame() {
  return frame(S2C_TERRAIN_DIRTY, std::string());
}

// ---------- C2S 解码 ----------
// 战斗/世界共享事件帧
std::string eventFrame(uint8_t evtType, uint32_t wid, uint32_t b, int32_t x, int32_t z) {
  Writer w;
  w.u8(evtType);
  w.u32(wid);
  w.u32(b);
  w.i32(x);
  w.i32(z);
  return frame(S2C_EVENT, w.data());
}
bool decodeInput(const std::string& payload, InputMsg& out) {
  Reader r(payload);
  uint32_t seq;
  int32_t px, pz;
  int16_t py;
  if (!r.u32(seq) || !r.i32(px) || !r.i16(py) || !r.i32(pz)) return false;
  out.seq = seq;
  out.px = dqAbs(px);
  out.py = dqAbs(py);
  out.pz = dqAbs(pz);
  return true;
}
bool decodeShopOpen(const std::string& payload, ShopOpenMsg& out) {
  Reader r(payload);
  return r.u32(out.npcWid);
}
bool decodeShopBuy(const std::string& payload, ShopBuyMsg& out) {
  Reader r(payload);
  return r.u32(out.itemId) && r.u16(out.count);
}
bool decodeShopSell(const std::string& payload, ShopSellMsg& out) {
  Reader r(payload);
  uint8_t isInst = 0;
  if (!r.u8(isInst)) return false;
  out.isInstance = isInst != 0;
  return r.u64(out.instId) && r.u32(out.itemId) && r.u16(out.count);
}
bool decodeEnhance(const std::string& payload, EnhanceMsg& out) {
  Reader r(payload);
  uint8_t useProtect = 0;
  if (!r.u64(out.instId)) return false;
  if (!r.u8(useProtect)) return false;
  out.useProtect = useProtect != 0;
  return true;
}
bool decodeDecompose(const std::string& payload, DecomposeMsg& out) {
  Reader r(payload);
  if (!r.u64(out.instId)) return false;
  return out.instId != 0;
}
bool decodeCraftList(const std::string& payload, CraftListMsg& out) {
  Reader r(payload);
  if (!r.u32(out.npcWid)) return false;
  return true;
}
bool decodeCraft(const std::string& payload, CraftMsg& out) {
  Reader r(payload);
  if (!r.u32(out.recipeId)) return false;
  if (!r.u16(out.count)) return false;
  if (out.count == 0) out.count = 1;
  return out.recipeId != 0;
}
bool decodeWarehouseOpen(const std::string& payload, WarehouseOpenMsg& out) {
  Reader r(payload);
  if (!r.u32(out.npcWid)) return false;
  return true;
}
// DEPOSIT/WITHDRAW 共用：u8 isInstance, u64 instId, u32 itemId, u16 count（对齐 decodeShopSell 固定布局）
bool decodeWarehouseMove(const std::string& payload, WarehouseMoveMsg& out) {
  Reader r(payload);
  uint8_t isInst = 0;
  if (!r.u8(isInst)) return false;
  out.isInstance = isInst != 0;
  return r.u64(out.instId) && r.u32(out.itemId) && r.u16(out.count);
}
bool decodePickup(const std::string& payload, PickupMsg& out) {
  Reader r(payload);
  return r.u32(out.dropWid);
}
bool decodeEquip(const std::string& payload, EquipMsg& out) {
  Reader r(payload);
  return r.u8(out.slot) && r.u64(out.instId);
}
bool decodeUseItem(const std::string& payload, UseItemMsg& out) {
  Reader r(payload);
  return r.u32(out.itemId) && r.u16(out.count);
}
bool decodeCastSkill(const std::string& payload, CastSkillMsg& out) {
  Reader r(payload);
  uint32_t skillId, targetWid;
  int32_t qx, qz;
  if (!r.u32(skillId) || !r.u32(targetWid) || !r.i32(qx) || !r.i32(qz)) return false;
  out.skillId = skillId;
  out.targetWid = targetWid;
  out.tx = dqAbs(qx);
  out.tz = dqAbs(qz);
  return true;
}
bool decodeAttack(const std::string& payload, AttackMsg& out) {
  Reader r(payload);
  uint32_t wid;
  uint8_t slot;
  if (!r.u32(wid) || !r.u8(slot)) return false;
  out.targetWid = wid;
  out.slot = slot;
  return true;
}
// ---------- 社交系统 C2S 解码 ----------
bool decodeFriendAdd(const std::string& payload, FriendAddMsg& out) {
  Reader r(payload);
  return r.str(out.targetName) && r.str(out.message);
}
bool decodeFriendAccept(const std::string& payload, FriendAcceptMsg& out) {
  Reader r(payload);
  return r.str(out.fromUser);
}
bool decodeFriendReject(const std::string& payload, FriendRejectMsg& out) {
  Reader r(payload);
  return r.str(out.fromUser);
}
bool decodeFriendRemove(const std::string& payload, FriendRemoveMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeFriendBlock(const std::string& payload, FriendBlockMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeFriendUnblock(const std::string& payload, FriendUnblockMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeGuildCreate(const std::string& payload, GuildCreateMsg& out) {
  Reader r(payload);
  return r.str(out.name);
}
bool decodeGuildApply(const std::string& payload, GuildApplyMsg& out) {
  Reader r(payload);
  return r.u32(out.guildId);
}
bool decodeGuildApprove(const std::string& payload, GuildApproveMsg& out) {
  Reader r(payload);
  return r.str(out.applicantName) && r.u8(out.approve);
}
bool decodeGuildKick(const std::string& payload, GuildKickMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeGuildPromote(const std::string& payload, GuildPromoteMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeGuildDemote(const std::string& payload, GuildDemoteMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeGuildTransfer(const std::string& payload, GuildTransferMsg& out) {
  Reader r(payload);
  return r.str(out.targetName);
}
bool decodeGuildNotice(const std::string& payload, GuildNoticeMsg& out) {
  Reader r(payload);
  return r.str(out.notice);
}
bool decodeGuildList(const std::string& payload, GuildListMsg& out) {
  Reader r(payload);
  return r.str(out.keyword);
}
bool decodeChatSend(const std::string& payload, ChatSendMsg& out) {
  Reader r(payload);
  return r.u8(out.channel) && r.str(out.target) && r.str(out.content);
}
// ---------- 社交系统 S2C 编码 ----------
std::string friendRequestFrame(const std::string& from, const std::string& message) {
  Writer w;
  w.str(from);
  w.str(message);
  return frame(S2C_FRIEND_REQUEST, w.data());
}
std::string friendListFrame(const std::vector<std::tuple<std::string, bool, std::string>>& friends) {
  Writer w;
  w.u16((uint16_t)friends.size());
  for (const auto& [name, online, remark] : friends) {
    w.str(name);
    w.u8(online ? 1 : 0);
    w.str(remark);
  }
  return frame(S2C_FRIEND_LIST, w.data());
}
std::string friendStatusFrame(const std::string& name, bool online) {
  Writer w;
  w.str(name);
  w.u8(online ? 1 : 0);
  return frame(S2C_FRIEND_STATUS, w.data());
}
std::string friendResultFrame(uint8_t opCode, uint8_t resultCode) {
  Writer w;
  w.u8(opCode);
  w.u8(resultCode);
  return frame(S2C_FRIEND_RESULT, w.data());
}
std::string guildInfoFrame(const GuildInfoData& g) {
  Writer w;
  w.u32(g.guildId);
  w.str(g.name);
  w.str(g.notice);
  w.str(g.leaderUsername);
  w.u32(g.memberCount);
  w.u32(g.maxMembers);
  w.u32((uint32_t)g.level);
  w.u32((uint32_t)g.exp);
  w.u32(g.logo);
  w.u32((uint32_t)g.createdMs);
  w.u16((uint16_t)g.members.size());
  for (const auto& m : g.members) {
    w.str(m.username);
    w.u8(m.role);
    w.u32((uint32_t)m.joinMs);
    w.u32((uint32_t)m.lastActiveMs);
    w.u32((uint32_t)m.contributionPts);
    w.str(m.title);
    w.u8(m.online ? 1 : 0);
  }
  return frame(S2C_GUILD_INFO, w.data());
}
std::string guildResultFrame(uint8_t opCode, uint8_t code, const std::string& extra) {
  Writer w;
  w.u8(opCode);
  w.u8(code);
  w.str(extra);
  return frame(S2C_GUILD_RESULT, w.data());
}
std::string guildNotifyFrame(uint8_t eventType, const std::string& data) {
  Writer w;
  w.u8(eventType);
  w.str(data);
  return frame(S2C_GUILD_NOTIFY, w.data());
}
std::string guildListFrame(const std::vector<GuildBriefData>& guilds) {
  Writer w;
  w.u16((uint16_t)guilds.size());
  for (const auto& g : guilds) {
    w.u32(g.guildId);
    w.str(g.name);
    w.u32(g.memberCount);
    w.u32((uint32_t)g.level);
    w.u32(g.logo);
  }
  return frame(S2C_GUILD_LIST, w.data());
}
std::string guildApplyNotifyFrame(const std::string& applicant, uint32_t guildId) {
  Writer w;
  w.str(applicant);
  w.u32(guildId);
  return frame(S2C_GUILD_APPLY_N, w.data());
}
std::string chatMsgFrame(uint8_t channel, const std::string& sender, uint32_t senderWid,
                         const std::string& content, uint64_t timestampMs) {
  Writer w;
  w.u8(channel);
  w.str(sender);
  w.u32(senderWid);
  w.str(content);
  w.u32((uint32_t)timestampMs);
  return frame(S2C_CHAT_MSG, w.data());
}
std::string chatHistoryFrame(const std::vector<ChatMsgData>& msgs) {
  Writer w;
  w.u16((uint16_t)msgs.size());
  for (const auto& m : msgs) {
    w.u8(m.channel);
    w.str(m.senderName);
    w.u32(m.senderWid);
    w.str(m.targetName);
    w.str(m.content);
    w.u32((uint32_t)m.timestampMs);
  }
  return frame(S2C_CHAT_HISTORY, w.data());
}
std::string chatResultFrame(uint8_t code, const std::string& errorMsg) {
  Writer w;
  w.u8(code);
  w.str(errorMsg);
  return frame(S2C_CHAT_RESULT, w.data());
}
// ---------- 任务系统 C2S 解码 ----------
bool decodeQuestAccept(const std::string& payload, QuestAcceptMsg& out) {
  Reader r(payload);
  return r.u32(out.questId) && r.u32(out.npcWid);
}
bool decodeQuestAbandon(const std::string& payload, QuestAbandonMsg& out) {
  Reader r(payload);
  return r.u32(out.questId);
}
bool decodeQuestTurnIn(const std::string& payload, QuestTurnInMsg& out) {
  Reader r(payload);
  return r.u32(out.questId) && r.u32(out.npcWid);
}
bool decodeQuestList(const std::string& payload, QuestListMsg& out) {
  Reader r(payload);
  return r.u32(out.npcWid);
}
bool decodeTalkNpc(const std::string& payload, TalkNpcMsg& out) {
  Reader r(payload);
  return r.u32(out.npcWid);
}
} // namespace proto
} // namespace ew
