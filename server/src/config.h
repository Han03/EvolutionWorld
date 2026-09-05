// config.h - 全局配置（世界/物理/防作弊参数集中管理）
#pragma once
#include <cstdint>
#include <string>

namespace ew {

struct Config {
  // ---- 服务 ----
  int port = 3000;
  std::string host = "0.0.0.0";
  std::string clientDir = "../client/dist";   // Vite 构建产物目录
  std::string dataDir = "data";      // 商店配置目录（shop.json）
  int sessionTtlSec = 24 * 3600;

  // ---- 世界 ----
  int worldSeed = 0;   // 0 = 每次启动随机生成（可通过 EW_SEED 环境变量覆盖）
  float viewRangeM = 100.0f;   // 可见/加载范围（半径，米）
  float chunkSizeM = 50.0f;    // 区块边长
  int terrainGridPoints = 33;  // 区块高度场数据每边采样点数（世界地图数据存储粒度）
  int monsterCount = 24;
  int npcCount = 12;
  // ---- 世界初始化执行器（大型网游规模：数据驱动生成，代码不保存地形/生物布局）----
  // 每次内存模式启动 / 编辑器“重新初始化世界”时，由 WorldInitializer 依据以下参数生成：
  //   岛屿 + 主城 + 连通道路网 + 分组生物投放（近弱远强）。
  int worldCityCount = 5;                  // 主城数量 X（标号 0..X-1，玩家出生在主城 0）
  double worldCityRadius = 50.0;           // 主城可通行圆盘半径（米），>=100m×100m
  int worldNpcGroupsPerCity = 4;           // 每城 NPC 组别数（每组含基础功能/任务/商店/铁匠各一）
  double worldIslandRingDist = 120.0;      // 大岛环形分布距离参考值（实际由不重叠约束自动求解）
  double worldSmallIslandMinR = 5.0;       // 小岛最小半径（米）
  double worldSmallIslandMaxR = 12.0;      // 小岛最大半径（米）
  double worldRoadWidth = 4.5;             // 岛屿连接道路半宽（米）
  double worldMonsterFreeRadius = 55.0;    // 主城免怪半径（米）：主城范围内不投放怪物
  double worldMonsterMaxRadius = 120.0;    // 怪物投放最远距离（米）：越远实力越强
  int worldMonsterGroups = 30;             // 怪物群数量（相同怪物成群出现）
  int worldMonsterGroupMin = 3;            // 每群怪物数量下限
  int worldMonsterGroupMax = 6;            // 每群怪物数量上限
  double worldMonsterGroupSpacing = 14.0;  // 群锚点最小间距（米，避免怪物扎堆重叠）
  // ---- 世界怪物 & 世界精英（状态共享）----
  int eliteCount = 3;                 // 世界精英数量（全区共享实体）
  float eliteHp = 500.0f;             // 精英生命
  float eliteAttack = 18.0f;          // 精英攻击力
  float eliteAttackRange = 2.5f;      // 近战攻击范围
  float eliteAggroRange = 18.0f;      // 进入仇恨的侦测范围
  float eliteAttackCdSec = 0.9f;      // 精英普攻间隔（秒）
  float eliteRespawnSec = 30.0f;      // 精英死亡复活（秒）
  float eliteRegenPerSec = 4.0f;      // 脱战回血/秒
  float monsterRespawnSec = 10.0f;   // 普通怪物死亡复活（秒）
  float playerRespawnSec = 3.0f;     // 玩家死亡复活（秒）
  float playerAttackRange = 3.2f;    // 玩家攻击判定范围
  float playerAttackCdSec = 0.5f;    // 玩家攻击冷却（秒）
  float playerRegenPerSec = 3.0f;    // 玩家脱战回血/秒
  float playerMpRegenPerSec = 1.5f;  // 玩家脱战回蓝/秒
  double eliteDefense = 12.0;         // 世界精英防御力
  double eliteMp = 200.0;             // 世界精英蓝量

  // ---- AI（大型网游规模：状态机 + 时间片/距离分级调度）----
  float monsterAggroRange = 10.0f;   // 怪物仇恨侦测范围
  float monsterLeashRange = 24.0f;   // 最大追击距离（超出脱战回巢）
  float monsterAttackRange = 1.6f;   // 怪物近战攻击距离
  float monsterAttackCdSec = 1.0f;   // 怪物攻击间隔（秒）
  float monsterPatrolRadius = 12.0f; // 巡逻半径（围绕出生点）
  float monsterPatrolPauseSec = 2.0f;// 巡逻转向间隔下限（秒）
  float monsterPatrolArrive = 1.0f;  // 巡逻到达 waypoint 判定距离（米）
  float monsterRecoverRegenPerSec = 5.0f;  // 恢复态回血速率（HP/秒）
  float monsterRecoverSpeedMul = 2.5f;     // 恢复态移动速度倍率（相对基础速度）
  float monsterRecoverChaseThreshold = 15.0f; // 追击超时阈值（秒）：仇恨态连续追击超过此时长触发恢复态（被攻击时重置）
  float eliteChaseSpeed = 3.0f;       // 精英追击速度（m/s）
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
  float maxMoveSpeed = 7.0f;
  float acceleration = 40.0f;
  float friction = 12.0f;
  float playerRadius = 0.55f;

  // ---- 防作弊 ----
  int maxInputRatePerSec = 40;   // 输入上报频率上限（/s）
  int inputBurst = 60;           // 短时突发容忍（1s 窗口内）
  int rateKickAfter = 15;        // 窗口内超频丢弃达到该次数直接踢出
  int sampleRatePct = 30;        // 随机采样校验比例（0-100）
  float teleportToleranceM = 5.0f;  // 横向轨迹校验容错（网络抖动+预测误差+碰撞推挤发散）
  // 地形校验容错（圆盘半径收缩量）：吸收上报 0.01m 量化与双端浮点分歧。
  // 严格级（radius）失败时收缩到 radius-该值再判一次，通过则把位置夹紧回严格可通行点，
  // 因此该值同时是「允许贴墙多近」的上限；远小于 1m 格宽，视觉上无可见穿墙。
  // 设为 0 可退回旧的零容差硬判定。
  float terrainToleranceM = 0.15f;
  int kickThreshold = 6;         // 累计违规达到该阈值踢出（terrain_blocked 软失败不计入）
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
