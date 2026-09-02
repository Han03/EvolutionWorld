// config.h - 全局配置（世界/物理/防作弊参数集中管理）
#pragma once
#include <cstdint>
#include <string>

namespace ew {

struct Config {
  // ---- 服务 ----
  int port = 3000;
  std::string host = "0.0.0.0";
  std::string clientDir = "../client";   // 相对服务端运行目录，或绝对路径
  std::string userDbFile = "data/users.json";
  std::string dataDir = "data";      // 物品/怪物/商店配置目录（items.json/monsters.json/shop.json）
  int sessionTtlSec = 24 * 3600;

  // ---- 世界 ----
  int worldSeed = 20260901;
  float viewRangeM = 100.0f;   // 可见/加载范围（半径，米）
  float chunkSizeM = 50.0f;    // 区块边长
  int terrainGridPoints = 33;  // 区块高度场数据每边采样点数（世界地图数据存储粒度）
  int monsterCount = 24;
  int npcCount = 12;
  // ---- 世界怪物 & 世界 Boss（状态共享）----
  int bossCount = 3;                 // 世界 Boss 数量（全区共享实体）
  float bossHp = 500.0f;             // Boss 生命
  float bossAttack = 18.0f;          // Boss 攻击力
  float bossAttackRange = 2.5f;      // 近战攻击范围
  float bossAggroRange = 18.0f;      // 进入仇恨的侦测范围
  float bossAttackCdSec = 0.9f;      // Boss 普攻间隔（秒）
  float bossRespawnSec = 30.0f;      // Boss 死亡复活（秒）
  float bossRegenPerSec = 4.0f;      // 脱战回血/秒
  float monsterRespawnSec = 10.0f;   // 普通怪物死亡复活（秒）
  float playerRespawnSec = 8.0f;     // 玩家死亡复活（秒）
  float playerAttackRange = 3.2f;    // 玩家攻击判定范围
  float playerAttackCdSec = 0.5f;    // 玩家攻击冷却（秒）
  float playerRegenPerSec = 3.0f;    // 玩家脱战回血/秒
  float playerMpRegenPerSec = 1.5f;  // 玩家脱战回蓝/秒
  double bossDefense = 12.0;         // 世界 Boss 防御力
  double bossMp = 200.0;             // 世界 Boss 蓝量

  // ---- AI（大型网游规模：状态机 + 时间片/距离分级调度）----
  float monsterAggroRange = 10.0f;   // 怪物仇恨侦测范围
  float monsterLeashRange = 24.0f;   // 最大追击距离（超出脱战回巢）
  float monsterAttackRange = 1.6f;   // 怪物近战攻击距离
  float monsterAttackCdSec = 1.0f;   // 怪物攻击间隔（秒）
  float monsterPatrolRadius = 12.0f; // 巡逻半径（围绕出生点）
  float monsterPatrolPauseSec = 2.0f;// 巡逻转向间隔下限（秒）
  float monsterPatrolArrive = 1.0f;  // 巡逻到达 waypoint 判定距离（米）
  float bossChaseSpeed = 3.0f;       // Boss 追击速度（m/s）
  // AI LOD 分级：距最近玩家 <aiLodNearM 每 tick、<aiLodMidM 每 2 tick、其余每 aiLodFarStride tick
  float aiLodNearM = 25.0f;
  float aiLodMidM = 50.0f;
  uint32_t aiLodFarStride = 4;

  // ---- 模拟 ----
  float tickRateHz = 20.0f;
  float tickMs = 50.0f;
  // ---- 大规模传输方案（AOI / 增量 / LOD / 校准快照）----
  float aoiCellSizeM = 25.0f;      // AOI 空间网格边长
  float aoiNearM = 25.0f;          // 近距：每 tick 更新
  float aoiMidM = 50.0f;           // 中距：每 2 tick
  int snapshotIntervalTicks = 30;  // 校准全量快照周期（30 tick = 1.5s）

  // ---- 物理 ----
  float gravity = -9.81f;
  float jumpVelocity = 7.0f;
  float maxMoveSpeed = 7.0f;
  float acceleration = 40.0f;
  float friction = 12.0f;
  float playerRadius = 0.55f;

  // ---- 防作弊 ----
  int maxInputRatePerSec = 40;   // 输入上报频率上限（/s）
  int inputBurst = 60;           // 短时突发容忍（1s 窗口内）
  int rateKickAfter = 15;        // 窗口内超频丢弃达到该次数直接踢出
  int sampleRatePct = 30;        // 随机采样校验比例（0-100）
  float teleportToleranceM = 3.0f;  // 横向轨迹校验容错（网络抖动+预测误差）
  float verticalToleranceM = 6.0f;  // 纵向校验容错
  int kickThreshold = 6;         // 累计违规达到该阈值踢出
  int seqReorderWindow = 20;     // 乱序容忍窗口（允许回退的 seq 数）
  int seqJumpWindow = 80;        // 序号跳变容忍（允许前进的 seq 数）
  int graceInputs = 5;           // 出生后前 N 个输入免轨迹校验（允许初始误差）
  int maxInputBodyLen = 1024;    // 输入消息最大长度（防止超大包）

  // ---- 物品/掉落/商店 ----
  float dropLifetimeSec = 60.0f;     // 地面掉落物存活时间（秒），超时消失
  float pickupRangeM = 2.0f;         // 拾取判定半径（米）
  float shopOpenRangeM = 4.0f;       // 商店 NPC 交互距离（米）

  // ---- 社交系统（好友/公会/聊天）----
  uint32_t maxFriends = 100;          // 好友上限
  uint32_t maxFriendRequests = 20;    // 待处理好友请求上限
  uint32_t maxGuildMembers = 50;      // 公会初始成员上限
  uint32_t maxGuildApplications = 20; // 公会待审批申请上限
  uint32_t chatWorldCooldownMs = 5000;// 世界频道发言冷却（毫秒）
  uint32_t chatMinIntervalMs = 1000;  // 聊天最小间隔（防刷）
  uint32_t chatMaxLen = 200;          // 单条消息最大字符数
  uint32_t chatOfflineMaxMsgs = 50;   // 离线信箱上限
  uint32_t chatWorldHistorySize = 100;// 世界频道历史条数
  uint32_t guildCreateCost = 1000;    // 创建公会金币消耗

  // ---- 任务系统（大型网游规模，数据驱动）----
  uint32_t maxActiveQuests = 20;        // 同时进行任务上限
  uint32_t maxCompletedQuests = 500;    // 已完成记录上限
  float questTalkRangeM = 4.0f;         // NPC 对话/接取/提交距离（米）
  float questReachRadius = 5.0f;        // 到达目标默认判定半径（米）
  uint32_t dailyQuestResetHour = 5;     // 日常任务每日重置时间（小时，服务器时间）
};

} // namespace ew
