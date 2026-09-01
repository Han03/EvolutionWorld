// store.h - 存储系统抽象（MySQL + Redis + 内存降级）
//
// 设计目标（对应需求：基于 MySQL+Redis 设计存储系统，不连接也不影响功能）：
//   1. 单一抽象接口 IStore：账号 / 玩家存档 / 会话 / 缓存，内存与外部后端可互换
//   2. 内存后端永远可用（兜底）：无 MySQL/Redis、或连接失败/运行中断线时，
//      所有读写自动落到内存，功能不受影响
//   3. 外部后端尽力而为：MySQL 持久化账号与玩家存档；Redis 缓存会话与热点数据
//   4. 启动探测 + 运行期降级：连不上/断线只打日志并降级，不抛异常不崩溃
#pragma once
#include <string>
#include <memory>
#include <cstdint>
#include <vector>
#include "../config.h"

namespace ew {

class MemoryStore; // 内存兜底后端（定义在 store.cpp，永远可用）

// 账号记录（与 auth 侧对齐）
struct UserRecord {
  std::string username;
  std::string salt;
  std::string hash;      // 加盐 SHA-256 双轮哈希
  std::string createdAt; // 创建时间（ISO 或自定格式）
};

// 玩家存档（世界内状态快照）
struct PlayerSave {
  std::string username;
  float x = 0, y = 0, z = 0;
  float hp = 100;
  int level = 1;
  uint64_t updatedAtMs = 0; // 服务端单调时钟（写回时间戳）
  // 物品系统扩展：金币 + 装备(槽位->itemId 的 JSON) + 背包(itemId->数量 的 JSON)
  uint32_t gold = 0;
  std::string equipJson;    // 例如 {"helm":1001,"weapon":1501} 或空
  std::string inventoryJson;// 例如 {"2001":5,"3001":3} 或空
};

// 存储后端抽象
class IStore {
public:
  virtual ~IStore() = default;
  // 后端当前是否可用（连接失败/断线返回 false）
  virtual bool available() const = 0;
  virtual const char* backendName() const = 0;

  // ---- 账号 ----
  virtual bool upsertUser(const UserRecord& u) = 0;
  virtual bool getUser(const std::string& username, UserRecord& out) = 0;
  virtual bool userExists(const std::string& username) = 0;
  // 全量加载账号（MySQL 后端用于启动灌入内存；其余后端返回空）
  virtual std::vector<UserRecord> loadAllUsers() { return {}; }

  // ---- 玩家存档 ----
  virtual bool savePlayer(const PlayerSave& s) = 0;
  virtual bool loadPlayer(const std::string& username, PlayerSave& out) = 0;

  // ---- 会话（token -> username，带 TTL）----
  virtual bool putSession(const std::string& token, const std::string& username, uint32_t ttlSec) = 0;
  virtual std::string getSession(const std::string& token) = 0;
  virtual bool delSession(const std::string& token) = 0;

  // ---- 通用 KV 缓存（带 TTL）----
  virtual bool cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec) = 0;
  virtual bool cacheGet(const std::string& key, std::string& out) = 0;
  virtual bool cacheDel(const std::string& key) = 0;
};

// 存储配置（环境变量驱动，见 store.cpp 解析）
struct StoreConfig {
  std::string mysqlHost = "";  // 空 = 不启用 MySQL
  int mysqlPort = 3306;
  std::string mysqlUser = "root";
  std::string mysqlPass = "";
  std::string mysqlDb = "evolutionworld";
  std::string redisHost = "";  // 空 = 不启用 Redis
  int redisPort = 6379;
  std::string redisPass = "";
  std::string redisPrefix = "ew:"; // 键前缀，避免与其他服务冲突
};

// 存储门面：对外提供统一读写入口，内部自动路由 + 降级
class Store {
public:
  Store(const Config& cfg, const StoreConfig& sc);
  ~Store();

  // 启动探测：尝试连接 MySQL/Redis，失败自动降级并记录日志
  void init();

  bool mysqlActive() const { return mysql_ && mysql_->available(); }
  bool redisActive() const { return redis_ && redis_->available(); }
  bool anyExternal() const { return mysqlActive() || redisActive(); }
  // 最近一次降级原因（用于日志/调试）
  const std::string& degradation() const { return degradation_; }

  // ---- 账号（内存优先 + MySQL 持久化；读失败回退内存）----
  void upsertUser(const UserRecord& u);          // 内存必写；MySQL 尽力
  bool getUser(const std::string& username, UserRecord& out);
  bool userExists(const std::string& username);
  // 启动时若 MySQL 可用，把账号全量灌入内存缓存（供 auth 使用）
  std::vector<UserRecord> mysqlLoadAllUsers();

  // ---- 玩家存档（内存兜底 + MySQL 持久化）----
  void savePlayer(const PlayerSave& s);
  bool loadPlayer(const std::string& username, PlayerSave& out);

  // ---- 会话（Redis 优先 + 内存兜底）----
  void putSession(const std::string& token, const std::string& username, uint32_t ttlSec);
  std::string getSession(const std::string& token);
  void delSession(const std::string& token);

  // ---- 通用缓存（Redis 优先 + 内存兜底）----
  void cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec);
  bool cacheGet(const std::string& key, std::string& out);
  void cacheDel(const std::string& key);

private:
  const Config& cfg_;
  StoreConfig sc_;
  std::unique_ptr<IStore> memory_; // 永远可用
  MemoryStore* mem_ = nullptr;      // 便捷访问内存后端（降级/启动灌入用）
  std::unique_ptr<IStore> redis_;  // 可选
  std::unique_ptr<IStore> mysql_;  // 可选
  std::string degradation_;
};

// 由环境变量解析存储配置
StoreConfig storeConfigFromEnv(const Config& cfg);

} // namespace ew
