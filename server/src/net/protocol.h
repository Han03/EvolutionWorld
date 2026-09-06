// protocol.h - 大规模 MMO 数据传输方案：二进制帧协议 + 量化编码
//
// 设计要点（对标大型网络游戏）：
//  - 二进制帧：magic + 版本 + 类型 + flags + seq + 长度，替代 JSON 文本（省 ~4-6x 带宽）
//  - 量化坐标：0.01m 精度定长编码，替代 double/float
//  - 相对坐标：AOI 内实体位置以"接收玩家位置"为基准编码（int16，6 字节/位置）
//  - 增量更新：仅发送变化字段（mask 位图），配合更新率分级（LOD）
//  - 生命周期：ENTITY_ENTER / ENTITY_LEAVE 显式管理，替代每 tick 全量快照
//  - 校准快照：周期性 SNAPSHOT 全量重建（丢包/失步自愈）
//  - 单帧批量：每 tick 每个玩家合并所有消息为一个 TCP 段（避免小包风暴）
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <utility>
#include "game/entity.h"
#include "config.h"
namespace ew {
namespace proto {
// ---------- 帧头 ----------
constexpr uint8_t kMagic0 = 0x45; // 'E'
constexpr uint8_t kMagic1 = 0x57; // 'W'
constexpr uint8_t kVersion = 1;
constexpr size_t kHeaderSize = 9;

// ---------- 消息类型 ----------
enum MsgType : uint8_t {
  // C2S
  C2S_INPUT = 0x01,   // 位置上报（纯物理位置）
  C2S_EVENT = 0x02,   // 通用事件（预留：聊天/技能/交互…）
  C2S_PONG  = 0x03,   // 心跳应答
  C2S_ATTACK= 0x04,   // 攻击世界实体（目标 wid + 技能槽）
  C2S_SHOP_OPEN = 0x05, // 打开商店（目标 NPC wid）
  C2S_SHOP_BUY  = 0x06, // 购买物品（itemId + 数量）
  C2S_PICKUP    = 0x07, // 拾取地面掉落物（drop wid）
  C2S_EQUIP     = 0x08, // 穿戴/卸下装备（slot 槽位值 + itemId，0=卸下）
  C2S_USE_ITEM  = 0x09, // 使用消耗品（itemId + 数量）
  C2S_CAST_SKILL= 0x0A, // 施放技能（skillId + 目标 wid + 落点 x/z）
  C2S_CONSOLE   = 0x0B, // 控制台命令（utf-8 文本；EW_DEBUG 或常开门控）
  // ---- 任务系统 C2S ----
  C2S_QUEST_ACCEPT  = 0x0C, // 接受任务 (u32: questId, u32: npcWid)
  C2S_QUEST_ABANDON = 0x0D, // 放弃任务 (u32: questId)
  C2S_QUEST_TURNIN  = 0x0E, // 提交任务 (u32: questId, u32: npcWid)
  C2S_QUEST_LIST    = 0x0F, // 请求可接任务列表 (u32: npcWid, 0=全部)
  C2S_QUEST_TRACK   = 0x17, // 请求任务进度详情
  C2S_TALK_NPC      = 0x18, // 与 NPC 对话（触发任务目标）(u32: npcWid)
  // ---- 社交系统 C2S ----
  C2S_FRIEND_ADD     = 0x10, // 发送好友请求 (str: targetUsername, str: message)
  C2S_FRIEND_ACCEPT  = 0x11, // 接受请求 (str: fromUsername)
  C2S_FRIEND_REJECT  = 0x12, // 拒绝请求 (str: fromUsername)
  C2S_FRIEND_REMOVE  = 0x13, // 删除好友 (str: targetUsername)
  C2S_FRIEND_BLOCK   = 0x14, // 拉黑 (str: targetUsername)
  C2S_FRIEND_UNBLOCK = 0x15, // 取消拉黑 (str: targetUsername)
  C2S_FRIEND_LIST    = 0x16, // 请求好友列表
  C2S_GUILD_CREATE   = 0x20, // 创建公会 (str: name)
  C2S_GUILD_DISBAND  = 0x21, // 解散公会
  C2S_GUILD_APPLY    = 0x22, // 申请入会 (uint32: guildId)
  C2S_GUILD_APPROVE  = 0x23, // 审批入会 (str: applicantName, u8: approve)
  C2S_GUILD_KICK     = 0x24, // 踢出成员 (str: targetName)
  C2S_GUILD_PROMOTE  = 0x25, // 晋升 (str: targetName)
  C2S_GUILD_DEMOTE   = 0x26, // 降级 (str: targetName)
  C2S_GUILD_LEAVE    = 0x27, // 退出公会
  C2S_GUILD_TRANSFER = 0x28, // 转让会长 (str: targetName)
  C2S_GUILD_NOTICE   = 0x29, // 编辑公告 (str: notice)
  C2S_GUILD_INFO     = 0x2A, // 请求公会信息
  C2S_GUILD_LIST     = 0x2B, // 请求公会列表（搜索）
  C2S_CHAT_SEND      = 0x30, // 发送聊天消息 (u8: channel, str: target, str: content)
  // ---- 经济系统 C2S（0x40-0x4F）----
  C2S_SHOP_SELL      = 0x40, // 出售回收 (u8 isInstance, u64 instId, u32 itemId, u16 count)
  C2S_ENHANCE        = 0x41, // 装备强化 (u64 instId, u8 useProtect)
  C2S_DECOMPOSE      = 0x42, // 装备分解 (u64 instId)
  C2S_CRAFT_LIST     = 0x43, // 合成配方列表 (u32 npcWid，按 NPC 过滤)
  C2S_CRAFT          = 0x44, // 物品合成 (u32 recipeId, u16 count)
  C2S_WAREHOUSE_OPEN     = 0x45, // 打开仓库 (u32 npcWid)
  C2S_WAREHOUSE_DEPOSIT  = 0x46, // 存入 (u8 isInstance, u64 instId / u32 itemId, u16 count)
  C2S_WAREHOUSE_WITHDRAW = 0x47, // 取出 (u8 isInstance, u64 instId / u32 itemId, u16 count)
  C2S_WAREHOUSE_EXPAND   = 0x48, // 扩展仓库 (无 payload)
  // S2C
  S2C_HELLO   = 0x81, // 握手（world 参数 + 自身完整状态）
  S2C_SNAPSHOT= 0x82, // 校准快照（周期全量，自愈）
  S2C_ENTER   = 0x83, // 实体进入视野
  S2C_LEAVE   = 0x84, // 实体离开视野
  S2C_UPDATE  = 0x85, // 实体增量状态
  S2C_SELF    = 0x86, // 自身权威位置（预测回退/校正）
  S2C_EVENT   = 0x87, // 通用事件（战斗事件：伤害/死亡/复活/技能）
  S2C_PING    = 0x88, // 心跳
  S2C_KICK    = 0x89, // 踢出
  S2C_ERROR   = 0x8A, // 错误
  S2C_ELITE    = 0x8B, // 世界精英全局共享状态（血量/阶段/状态/目标/位置）
  S2C_SHOP     = 0x8C, // 商店列表（shopId/名称/商品条目）
  S2C_INVENTORY= 0x8D, // 背包/装备/金币 全量（服务端权威）
  S2C_LOOT     = 0x8E, // 拾取反馈（获得物品/金币）
  S2C_STATS    = 0x8F, // 自身属性（血量/蓝量/攻击/防御）更新
  S2C_SKILLS   = 0x90, // 已学技能列表 + 剩余冷却（服务端权威）
  S2C_SKILL_CAST = 0x91, // 技能施放反馈（success + skillId + 目标 wid + 落点）
  S2C_BUFFS    = 0x92, // 自身 Buff 列表（skillId/type/value/remain）
  S2C_CONSOLE  = 0x93, // 控制台命令结果（utf-8 文本，逐行）
  // 地形数据已变更（编辑层保存 / 世界重新初始化）：零 payload，仅作「请重拉」信号。
  // 客户端收到后重拉 /api/terrain/mask 与 /api/terrain/edit。不随帧携带全量数据的原因：
  // 帧头 len 为 u16（上限 65535B），而 256×256 mask 原始 65536B、base64 后 87384B，
  // 单帧装不下；且地形编辑属低频运维操作，重拉成本可接受。
  // 向后兼容：旧客户端 parseS2C 的 default 分支返回 {type}，收到此帧会被安全忽略。
  S2C_TERRAIN_DIRTY = 0x94,
  // ---- 社交系统 S2C ----
  S2C_FRIEND_REQUEST = 0xA0, // 收到好友请求 (str: from, str: message)
  S2C_FRIEND_LIST    = 0xA1, // 好友列表 (u16: count, [str: name, u8: online, str: remark]...)
  S2C_FRIEND_STATUS  = 0xA2, // 好友上下线 (str: name, u8: online)
  S2C_FRIEND_RESULT  = 0xA3, // 操作结果 (u8: opCode, u8: resultCode)
  S2C_GUILD_INFO     = 0xB0, // 公会完整信息（成员列表/公告/设置）
  S2C_GUILD_RESULT   = 0xB1, // 操作结果 (u8: opCode, u8: code, payload)
  S2C_GUILD_NOTIFY   = 0xB2, // 公会事件通知（新成员/踢出/公告变更等）
  S2C_GUILD_LIST     = 0xB3, // 公会搜索列表
  S2C_GUILD_APPLY_N  = 0xB4, // 新入会申请通知（在线官员收到）
  S2C_CHAT_MSG       = 0xC0, // 收到聊天消息 (u8: channel, str: sender, u32: senderWid, str: content, u64: timestamp)
  S2C_CHAT_HISTORY   = 0xC1, // 历史消息批量 (u16: count, [ChatMessage...])
  S2C_CHAT_RESULT    = 0xC2, // 发送结果 (u8: code, str: errorMsg)
  // ---- 任务系统 S2C ----
  S2C_QUEST_LIST     = 0xD0, // 可接任务列表（含 giverNpcWid + nextQuestIds）
  S2C_QUEST_PROGRESS = 0xD1, // 活跃任务进度
  S2C_QUEST_RESULT   = 0xD2, // 操作结果（接受/放弃/提交）
  S2C_QUEST_COMPLETE = 0xD3, // 任务完成通知（目标全部达成）
  S2C_QUEST_NOTIFY   = 0xD4, // 任务目标进度更新推送
  S2C_QUEST_CHAIN    = 0xD5, // 链式任务解锁通知（完成当前任务后解锁的后续任务 ID 列表）
  S2C_NPC_DIALOGUE   = 0xD6, // NPC 对话文本 (str: dialogue)
  // ---- 经济系统 S2C（0xE0-0xEF）----
  S2C_ENHANCE        = 0xE0, // 强化结果 (u8 ok, u8 failCode, u64 instId, u8 newLevel, u8 success, u32 goldLeft)
  S2C_DECOMPOSE      = 0xE1, // 分解结果 (u8 ok, u8 failCode, u16 count, [u32 itemId, u16 count]..., u32 goldGain)
  S2C_CRAFT_LIST     = 0xE2, // 合成配方列表 (u16 count, [u32 recipeId]...)
  S2C_CRAFT          = 0xE3, // 合成结果 (u8 ok, u8 failCode, u32 recipeId, u32 resultItemId, u16 resultCount, u8 isInstance, u64 instId)
  S2C_WAREHOUSE       = 0xE4, // 仓库全量 (u32 gold, u32 unlocked, u16 slotCount, [u8 isInstance, u64 instId, u32 itemId, u8 enhance, u8 locked, u32 count]...)
  S2C_WAREHOUSE_RESULT= 0xE5, // 仓库操作结果 (u8 op, u8 code)
  S2C_SELL_RESULT    = 0xE6, // 出售回收结果 (u8 ok, u32 goldGain)
};
// ---------- 共享事件类型（S2C_EVENT payload 首字节） ----------
enum EvtType : uint8_t {
  EVT_DAMAGE  = 1,   // 伤害：wid 目标, b 伤害值(有符号), x 保留
  EVT_DEATH   = 2,   // 死亡：wid 死亡者, b 击杀者 wid
  EVT_RESPAWN = 3,   // 复活：wid 复活实体
  EVT_SKILL   = 4,   // 范围技能：wid 施法者, b skillId, x/z 技能落点
  EVT_DROP    = 5,   // 掉落：wid 掉落物实体, b itemId, x 金币量
  EVT_SKILL_CASTING = 6, // 技能前摇开始：wid 施法者, b skillId, x/z 施放落点（客户端画前摇圈）
  EVT_SKILL_CANCEL   = 7, // 技能前摇被打断：wid 施法者, b skillId, x 打断原因(1移动/2受击)
  EVT_HEAL      = 8,   // 治疗：wid 目标, b 治疗值, x 保留
};
// ---------- 精英状态位（S2C_ELITE.state，与 entity.h EliteState 一致） ----------
constexpr uint8_t ELITE_IDLE = 0;
constexpr uint8_t ELITE_ENGAGE = 1;
constexpr uint8_t ELITE_DEAD = 2;

// ---------- flags ----------
enum Flags : uint8_t {
  FLAG_ACK = 0x01,     // 要求客户端回 PONG
  FLAG_ZIP = 0x02,     // 预留：负载压缩
};

// ---------- 实体 kind（线上编码） ----------
constexpr uint8_t KIND_PLAYER = 1;
constexpr uint8_t KIND_MONSTER = 2;
constexpr uint8_t KIND_NPC = 3;
constexpr uint8_t KIND_ITEM = 4;   // 地面掉落物（物品/金币）

// ---------- 实体状态位 ----------
constexpr uint8_t ST_MOVING  = 0x01;
constexpr uint8_t ST_GROUNDED = 0x02;

// ---------- 增量 mask ----------
constexpr uint8_t M_POS   = 0x01; // 位置变化
constexpr uint8_t M_VEL   = 0x02; // 速度变化
constexpr uint8_t M_STATE = 0x04; // 状态（moving/grounded）变化
constexpr uint8_t M_INTENT = 0x08; // AI 移动意图变化（aiState + 目标速度 + 速度倍率）

// ---------- 量化常量 ----------
constexpr int kPosScale = 100;   // 位置 0.01m
constexpr int kVelScale = 100;   // 速度 0.01 m/s
constexpr int kMoveScale = 1000; // 移动输入 -1000..1000
constexpr int16_t kRelClamp = 32760; // int16 相对坐标钳制（±327.6m，覆盖 100m 视野）

// ---------- 帧 ----------
struct Frame {
  uint8_t type = 0;
  uint8_t flags = 0;
  uint16_t seq = 0;
  std::string payload;
};

// 二进制写入器（小端）
class Writer {
public:
  void u8(uint8_t v);
  void u16(uint16_t v);
  void u32(uint32_t v);
  void u64(uint64_t v);
  void i16(int16_t v);
  void i32(int32_t v);
  void f32(float v);
  void raw(const void* p, size_t n);
  void str(const std::string& s); // u8 长度 + 字节
  const std::string& data() const { return buf_; }
  size_t size() const { return buf_.size(); }
private:
  std::string buf_;
};

// 二进制读取器（小端，越界安全）
class Reader {
public:
  explicit Reader(const std::string& data) : p_((const uint8_t*)data.data()), end_(p_ + data.size()) {}
  bool u8(uint8_t& v);
  bool u16(uint16_t& v);
  bool u32(uint32_t& v);
  bool u64(uint64_t& v);
  bool i16(int16_t& v);
  bool i32(int32_t& v);
  bool f32(float& v);
  bool raw(void* out, size_t n);
  bool str(std::string& s);
  bool remaining(size_t n) const { return (size_t)(end_ - p_) >= n; }
  size_t left() const { return (size_t)(end_ - p_); }
private:
  const uint8_t* p_;
  const uint8_t* end_;
};

// ---------- 量化 ----------
inline int32_t qAbs(double v) { return (int32_t)std::lround(v * kPosScale); }
inline double dqAbs(int32_t q) { return (double)q / kPosScale; }
// 相对坐标（相对玩家位置），钳制到 int16 安全范围
inline int16_t qRel(double v, double ref) {
  int64_t q = (int64_t)std::lround((v - ref) * kPosScale);
  if (q > kRelClamp) q = kRelClamp;
  if (q < -kRelClamp) q = -kRelClamp;
  return (int16_t)q;
}
inline int16_t qVel(double v) {
  int64_t q = (int64_t)std::lround(v * kVelScale);
  if (q > 32760) q = 32760;
  if (q < -32760) q = -32760;
  return (int16_t)q;
}
inline int16_t qMove(double v) {
  int64_t q = (int64_t)std::lround(v * kMoveScale);
  if (q > 1000) q = 1000;
  if (q < -1000) q = -1000;
  return (int16_t)q;
}
// 实体状态位
inline uint8_t entityState(const Entity& e) {
  uint8_t s = 0;
  if (std::abs(e.vel.x) > 0.01 || std::abs(e.vel.z) > 0.01) s |= ST_MOVING;
  if (e.grounded) s |= ST_GROUNDED;
  return s;
}

// ---------- 帧编码 ----------
std::string frame(uint8_t type, const std::string& payload, uint8_t flags = 0, uint16_t seq = 0);
// 解析一帧（从 offset 处解析；不足返回 false 且不消费）
bool parseFrame(const std::string& data, size_t offset, size_t& consumed, Frame& f);

// ---------- S2C 编码 ----------
// 实体全量（相对 ref 编码；含 name 若 kind==Player）
void writeEntityFull(Writer& w, const Entity& e, const Vec3& ref);
std::string hello(const Config& cfg, const Entity& self);
std::string snapshot(uint32_t tick, const std::vector<const Entity*>& ents, const Vec3& ref);
std::string enter(const std::vector<const Entity*>& ents, const Vec3& ref);
std::string leave(const std::vector<uint32_t>& wids);
std::string update(const std::vector<uint32_t>& wids,
                   const std::vector<uint8_t>& masks,
                   const std::vector<const Entity*>& ents,
                   const Vec3& ref);
std::string selfCorrection(const std::string& reason, const Entity& p, uint32_t tick);
std::string ping(uint32_t ts);
std::string kick(const std::string& reason);
std::string error(uint8_t code, const std::string& msg);
// 世界共享状态（战斗事件）
std::string eventFrame(uint8_t evtType, uint32_t wid, uint32_t b, int32_t x, int32_t z);

// 世界共享状态编码：S2C_SHOP / S2C_INVENTORY / S2C_STATS / S2C_LOOT
// shopFrame：buyer 非空时按玩家 shopBuyCount 附带每个限购条目的已购数量（限购进度）
std::string shopFrame(const struct ShopDef& shop, const Entity* buyer = nullptr);
std::string inventoryFrame(const Entity& p);
std::string statsFrame(const Entity& p);
std::string lootFrame(bool ok, uint32_t itemId, uint16_t count, uint32_t gold);
// 出售回收结果（阶段1）：S2C_SELL_RESULT
std::string sellResultFrame(bool ok, uint32_t goldGain);
// 装备强化结果（阶段2）：S2C_ENHANCE
// payload: u8 ok, u8 failCode, u64 instId, u8 newLevel, u8 success, u32 goldLeft
std::string enhanceFrame(bool ok, uint8_t failCode, uint64_t instId, uint8_t newLevel, bool success, uint32_t goldLeft);
// 装备分解结果（阶段3）：S2C_DECOMPOSE
// payload: u8 ok, u8 failCode, u16 itemCount, [u32 itemId, u16 count]..., u32 goldGain
std::string decomposeFrame(bool ok, uint8_t failCode, const std::vector<std::pair<uint32_t, uint32_t>>& items, uint32_t goldGain);
// 合成配方列表（阶段4）：S2C_CRAFT_LIST
// payload: u16 count, [u32 recipeId]...
std::string craftListFrame(const std::vector<uint32_t>& recipeIds);
// 合成结果（阶段4）：S2C_CRAFT
// payload: u8 ok, u8 failCode, u32 recipeId, u32 resultItemId, u16 resultCount, u8 isInstance, u64 instId
std::string craftFrame(bool ok, uint8_t failCode, uint32_t recipeId, uint32_t resultItemId, uint16_t resultCount, bool isInstance, uint64_t instId);
// 仓库全量（阶段5）：S2C_WAREHOUSE
// payload: u32 gold, u32 unlocked, u16 slotCount, [u8 isInstance, u64 instId, u32 itemId, u8 enhance, u8 locked, u32 count]...
std::string warehouseFrame(const WarehouseData& wh);
// 仓库操作结果（阶段5）：S2C_WAREHOUSE_RESULT
// payload: u8 op, u8 code
std::string warehouseResultFrame(uint8_t op, uint8_t code);

// 技能/控制台：S2C_SKILLS / S2C_SKILL_CAST / S2C_CONSOLE
std::string skillCastFrame(bool ok, uint32_t skillId, uint32_t targetWid, int32_t x, int32_t z, uint16_t castTimeMs);
std::string consoleFrame(const std::string& text);
// 地形变更通知：S2C_TERRAIN_DIRTY（零 payload）
std::string terrainDirtyFrame();

// ---------- C2S 解码 ----------
struct InputMsg {
  uint32_t seq = 0;
  double px = 0, py = 0, pz = 0;
};
struct AttackMsg {
  uint32_t targetWid = 0;
  uint8_t slot = 0;   // 0=普攻，1..=技能（预留）
};
struct ShopOpenMsg { uint32_t npcWid = 0; };
struct ShopBuyMsg { uint32_t itemId = 0; uint16_t count = 0; };
struct ShopSellMsg { bool isInstance = false; uint64_t instId = 0; uint32_t itemId = 0; uint16_t count = 0; }; // 出售：装备实例或堆叠物品
struct EnhanceMsg { uint64_t instId = 0; bool useProtect = false; }; // 装备强化：目标实例 + 是否用保护符
struct DecomposeMsg { uint64_t instId = 0; }; // 装备分解：目标实例
struct CraftListMsg { uint32_t npcWid = 0; }; // 合成配方列表：按 NPC 过滤
struct CraftMsg { uint32_t recipeId = 0; uint16_t count = 1; }; // 物品合成：配方 + 批量数
struct WarehouseOpenMsg { uint32_t npcWid = 0; }; // 打开仓库：银行 NPC wid
struct WarehouseMoveMsg { bool isInstance = false; uint64_t instId = 0; uint32_t itemId = 0; uint16_t count = 0; }; // 存入/取出：装备实例 或 堆叠物品/金币(itemId=0)
struct PickupMsg { uint32_t dropWid = 0; };
struct EquipMsg { uint8_t slot = 0; uint64_t instId = 0; };  // instId=0 表示卸下（装备实例化）
struct UseItemMsg { uint32_t itemId = 0; uint16_t count = 0; };
struct CastSkillMsg { uint32_t skillId = 0; uint32_t targetWid = 0; double tx = 0, tz = 0; };
bool decodeInput(const std::string& payload, InputMsg& out);
bool decodeAttack(const std::string& payload, AttackMsg& out);
bool decodeShopOpen(const std::string& payload, ShopOpenMsg& out);
bool decodeShopBuy(const std::string& payload, ShopBuyMsg& out);
bool decodeShopSell(const std::string& payload, ShopSellMsg& out);
bool decodeEnhance(const std::string& payload, EnhanceMsg& out);
bool decodeDecompose(const std::string& payload, DecomposeMsg& out);
bool decodeCraftList(const std::string& payload, CraftListMsg& out);
bool decodeCraft(const std::string& payload, CraftMsg& out);
bool decodeWarehouseOpen(const std::string& payload, WarehouseOpenMsg& out);
bool decodeWarehouseMove(const std::string& payload, WarehouseMoveMsg& out); // DEPOSIT/WITHDRAW 共用
bool decodePickup(const std::string& payload, PickupMsg& out);
bool decodeEquip(const std::string& payload, EquipMsg& out);
bool decodeUseItem(const std::string& payload, UseItemMsg& out);
bool decodeCastSkill(const std::string& payload, CastSkillMsg& out);

// ---------- 社交系统 C2S 消息结构 ----------
struct FriendAddMsg { std::string targetName; std::string message; };
struct FriendAcceptMsg { std::string fromUser; };
struct FriendRejectMsg { std::string fromUser; };
struct FriendRemoveMsg { std::string targetName; };
struct FriendBlockMsg { std::string targetName; };
struct FriendUnblockMsg { std::string targetName; };

struct GuildCreateMsg { std::string name; };
struct GuildApplyMsg { uint32_t guildId = 0; };
struct GuildApproveMsg { std::string applicantName; uint8_t approve = 0; };
struct GuildKickMsg { std::string targetName; };
struct GuildPromoteMsg { std::string targetName; };
struct GuildDemoteMsg { std::string targetName; };
struct GuildTransferMsg { std::string targetName; };
struct GuildNoticeMsg { std::string notice; };
struct GuildListMsg { std::string keyword; };

struct ChatSendMsg { uint8_t channel = 0; std::string target; std::string content; };

// ---------- 任务系统 C2S 消息结构 ----------
struct QuestAcceptMsg { uint32_t questId = 0; uint32_t npcWid = 0; };
struct QuestAbandonMsg { uint32_t questId = 0; };
struct QuestTurnInMsg { uint32_t questId = 0; uint32_t npcWid = 0; };
struct QuestListMsg { uint32_t npcWid = 0; }; // 请求可接任务列表（npcWid>0 时按 NPC 过滤）
struct TalkNpcMsg { uint32_t npcWid = 0; };

// 公会信息数据（供 S2C_GUILD_INFO 编码）
struct GuildMemberData {
  std::string username;
  uint8_t role = 0;
  uint64_t joinMs = 0;
  uint64_t lastActiveMs = 0;
  uint64_t contributionPts = 0;
  std::string title;
  bool online = false;
};
struct GuildInfoData {
  uint32_t guildId = 0;
  std::string name;
  std::string notice;
  std::string leaderUsername;
  uint32_t memberCount = 0;
  uint32_t maxMembers = 50;
  uint64_t level = 1;
  uint64_t exp = 0;
  uint32_t logo = 0;
  uint64_t createdMs = 0;
  std::vector<GuildMemberData> members;
};
struct GuildBriefData {
  uint32_t guildId = 0;
  std::string name;
  uint32_t memberCount = 0;
  uint64_t level = 1;
  uint32_t logo = 0;
};
// 聊天消息数据（供 S2C_CHAT_HISTORY 编码）
struct ChatMsgData {
  uint8_t channel = 0;
  std::string senderName;
  uint32_t senderWid = 0;
  std::string targetName;
  std::string content;
  uint64_t timestampMs = 0;
};

bool decodeFriendAdd(const std::string& payload, FriendAddMsg& out);
bool decodeFriendAccept(const std::string& payload, FriendAcceptMsg& out);
bool decodeFriendReject(const std::string& payload, FriendRejectMsg& out);
bool decodeFriendRemove(const std::string& payload, FriendRemoveMsg& out);
bool decodeFriendBlock(const std::string& payload, FriendBlockMsg& out);
bool decodeFriendUnblock(const std::string& payload, FriendUnblockMsg& out);
bool decodeGuildCreate(const std::string& payload, GuildCreateMsg& out);
bool decodeGuildApply(const std::string& payload, GuildApplyMsg& out);
bool decodeGuildApprove(const std::string& payload, GuildApproveMsg& out);
bool decodeGuildKick(const std::string& payload, GuildKickMsg& out);
bool decodeGuildPromote(const std::string& payload, GuildPromoteMsg& out);
bool decodeGuildDemote(const std::string& payload, GuildDemoteMsg& out);
bool decodeGuildTransfer(const std::string& payload, GuildTransferMsg& out);
bool decodeGuildNotice(const std::string& payload, GuildNoticeMsg& out);
bool decodeGuildList(const std::string& payload, GuildListMsg& out);
bool decodeChatSend(const std::string& payload, ChatSendMsg& out);

// ---------- 任务系统 C2S 解码 ----------
bool decodeQuestAccept(const std::string& payload, QuestAcceptMsg& out);
bool decodeQuestAbandon(const std::string& payload, QuestAbandonMsg& out);
bool decodeQuestTurnIn(const std::string& payload, QuestTurnInMsg& out);
bool decodeQuestList(const std::string& payload, QuestListMsg& out);
bool decodeTalkNpc(const std::string& payload, TalkNpcMsg& out);

// ---------- 社交系统 S2C 编码 ----------
// 好友系统
std::string friendRequestFrame(const std::string& from, const std::string& message);
std::string friendListFrame(const std::vector<std::tuple<std::string, bool, std::string>>& friends);
std::string friendStatusFrame(const std::string& name, bool online);
std::string friendResultFrame(uint8_t opCode, uint8_t resultCode);
// 公会系统
std::string guildInfoFrame(const struct GuildInfoData& g);
std::string guildResultFrame(uint8_t opCode, uint8_t code, const std::string& extra = "");
std::string guildNotifyFrame(uint8_t eventType, const std::string& data);
std::string guildListFrame(const std::vector<struct GuildBriefData>& guilds);
std::string guildApplyNotifyFrame(const std::string& applicant, uint32_t guildId);
// 聊天系统
std::string chatMsgFrame(uint8_t channel, const std::string& sender, uint32_t senderWid,
                         const std::string& content, uint64_t timestampMs);
std::string chatHistoryFrame(const std::vector<struct ChatMsgData>& msgs);
std::string chatResultFrame(uint8_t code, const std::string& errorMsg);

} // namespace proto
} // namespace ew
