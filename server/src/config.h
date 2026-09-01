// config.h - 全局配置（世界/物理/防作弊参数集中管理）
#pragma once
#include <string>

namespace ew {

struct Config {
  // ---- 服务 ----
  int port = 3000;
  std::string host = "0.0.0.0";
  std::string clientDir = "../client";   // 相对服务端运行目录，或绝对路径
  std::string userDbFile = "data/users.json";
  int sessionTtlSec = 24 * 3600;

  // ---- 世界 ----
  int worldSeed = 20260901;
  float viewRangeM = 100.0f;   // 可见/加载范围（半径，米）
  float chunkSizeM = 50.0f;    // 区块边长
  int terrainGridPoints = 33;  // 区块高度场数据每边采样点数（世界地图数据存储粒度）
  int monsterCount = 24;
  int npcCount = 12;

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
};

} // namespace ew
