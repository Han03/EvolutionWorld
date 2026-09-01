// store.cpp - 存储门面：内存兜底 + MySQL/Redis 可选后端 + 自动降级
#include "store.h"
#include "redis_store.h"
#include "mysql_store.h"
#include <cstdlib>
#include <cstdio>
#include <ctime>
#include <unordered_map>
#include <algorithm>

namespace ew {

// ============ 内存后端（永远可用，进程内兜底） ============
struct MemUser { UserRecord u; };
struct MemSession { std::string username; uint64_t expiresAtMs; };
struct MemCacheEntry { std::string val; uint64_t expiresAtMs; };

class MemoryStore : public IStore {
public:
  MemoryStore() = default;
  bool available() const override { return true; }
  const char* backendName() const override { return "memory"; }
  uint64_t nowMs() const { return (uint64_t)time(nullptr) * 1000; }

  bool upsertUser(const UserRecord& u) override { users_[u.username] = u; return true; }
  bool getUser(const std::string& username, UserRecord& out) override {
    auto it = users_.find(username);
    if (it == users_.end()) return false;
    out = it->second;
    return true;
  }
  bool userExists(const std::string& username) override { return users_.count(username) > 0; }

  bool savePlayer(const PlayerSave& s) override { saves_[s.username] = s; return true; }
  bool loadPlayer(const std::string& username, PlayerSave& out) override {
    auto it = saves_.find(username);
    if (it == saves_.end()) return false;
    out = it->second;
    return true;
  }

  bool putSession(const std::string& token, const std::string& username, uint32_t ttlSec) override {
    sessions_[token] = {username, nowMs() + (uint64_t)ttlSec * 1000};
    return true;
  }
  std::string getSession(const std::string& token) override {
    auto it = sessions_.find(token);
    if (it == sessions_.end()) return "";
    if (it->second.expiresAtMs < nowMs()) { sessions_.erase(it); return ""; }
    return it->second.username;
  }
  bool delSession(const std::string& token) override {
    sessions_.erase(token);
    return true;
  }
  bool cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec) override {
    cache_[key] = {val, nowMs() + (uint64_t)ttlSec * 1000};
    return true;
  }
  bool cacheGet(const std::string& key, std::string& out) override {
    auto it = cache_.find(key);
    if (it == cache_.end()) return false;
    if (it->second.expiresAtMs < nowMs()) { cache_.erase(it); return false; }
    out = it->second.val;
    return true;
  }
  bool cacheDel(const std::string& key) override { cache_.erase(key); return true; }

  // 供 Store 门面在降级/路由时访问
  const std::unordered_map<std::string, UserRecord>& users() const { return users_; }
  std::unordered_map<std::string, UserRecord>& usersMut() { return users_; }

private:
  std::unordered_map<std::string, UserRecord> users_;
  std::unordered_map<std::string, PlayerSave> saves_;
  std::unordered_map<std::string, MemSession> sessions_;
  std::unordered_map<std::string, MemCacheEntry> cache_;
};

// ============ 配置解析（环境变量） ============
StoreConfig storeConfigFromEnv(const Config& cfg) {
  (void)cfg;
  StoreConfig sc;
  const char* m = getenv("EW_DB_MYSQL");
  if (m && *m) {
    std::string s = m;
    auto colon = s.rfind(':');
    if (colon != std::string::npos && s.find_first_not_of("0123456789", colon + 1) == std::string::npos) {
      sc.mysqlHost = s.substr(0, colon);
      sc.mysqlPort = atoi(s.substr(colon + 1).c_str());
    } else {
      sc.mysqlHost = s;
    }
    if (const char* v = getenv("EW_DB_MYSQL_USER")) sc.mysqlUser = v;
    if (const char* v = getenv("EW_DB_MYSQL_PASS")) sc.mysqlPass = v;
    if (const char* v = getenv("EW_DB_MYSQL_DB")) sc.mysqlDb = v;
  }
  const char* r = getenv("EW_DB_REDIS");
  if (r && *r) {
    std::string s = r;
    auto colon = s.rfind(':');
    if (colon != std::string::npos && s.find_first_not_of("0123456789", colon + 1) == std::string::npos) {
      sc.redisHost = s.substr(0, colon);
      sc.redisPort = atoi(s.substr(colon + 1).c_str());
    } else {
      sc.redisHost = s;
    }
    if (const char* v = getenv("EW_DB_REDIS_PASS")) sc.redisPass = v;
    if (const char* v = getenv("EW_DB_REDIS_PREFIX")) sc.redisPrefix = v;
  }
  return sc;
}

// ============ Store 门面 ============
Store::Store(const Config& cfg, const StoreConfig& sc) : cfg_(cfg), sc_(sc) {
  memory_.reset(new MemoryStore());
  mem_ = static_cast<MemoryStore*>(memory_.get());
}
Store::~Store() = default;

void Store::init() {
  // Redis（会话/缓存）
  if (!sc_.redisHost.empty()) {
    auto r = std::make_unique<RedisStore>(sc_);
    if (r->init()) {
      redis_ = std::move(r);
      fprintf(stderr, "[store] Redis 已连接 %s:%d（会话/缓存后端）\n",
              sc_.redisHost.c_str(), sc_.redisPort);
    } else {
      degradation_ = "Redis 连接失败，会话/缓存降级到内存";
      fprintf(stderr, "[store] Redis 连接失败 %s:%d —— 降级到内存（不影响功能）\n",
              sc_.redisHost.c_str(), sc_.redisPort);
    }
  }
  // MySQL（账号/玩家存档）
  if (!sc_.mysqlHost.empty()) {
    auto m = std::make_unique<MysqlStore>(sc_);
    if (m->init()) {
      mysql_ = std::move(m);
      // 启动时把 MySQL 账号灌入内存缓存（auth 以内存为读权威，保证降级无缝）
      for (auto& u : mysql_->loadAllUsers()) mem_->upsertUser(u);
      fprintf(stderr, "[store] 从 MySQL 加载账号 %zu 条到内存缓存\n", mem_->users().size());
    } else {
      if (!degradation_.empty()) degradation_ += "；";
      degradation_ += "MySQL 连接失败，账号/存档降级到内存";
    }
  }
  if (!anyExternal()) {
    fprintf(stderr, "[store] 未启用外部存储（EW_DB_MYSQL/EW_DB_REDIS 未设置或连接失败）—— 纯内存模式\n");
  }
}

// ---- 账号 ----
void Store::upsertUser(const UserRecord& u) {
  memory_->upsertUser(u);      // 内存必写（读权威 + users.json 由 auth 负责）
  if (mysql_) mysql_->upsertUser(u); // MySQL 尽力
}
bool Store::getUser(const std::string& username, UserRecord& out) {
  if (memory_->getUser(username, out)) return true;
  if (mysql_ && mysql_->getUser(username, out)) return true; // 内存未命中回退 MySQL
  return false;
}
bool Store::userExists(const std::string& username) {
  return memory_->userExists(username) || (mysql_ && mysql_->userExists(username));
}
std::vector<UserRecord> Store::mysqlLoadAllUsers() {
  return mysql_ ? mysql_->loadAllUsers() : std::vector<UserRecord>();
}

// ---- 玩家存档 ----
void Store::savePlayer(const PlayerSave& s) {
  memory_->savePlayer(s);
  if (mysql_) mysql_->savePlayer(s);
}
bool Store::loadPlayer(const std::string& username, PlayerSave& out) {
  // MySQL 优先（跨进程持久），未命中回退内存
  if (mysql_) {
    PlayerSave m;
    if (mysql_->loadPlayer(username, m)) { out = m; return true; }
  }
  return memory_->loadPlayer(username, out);
}

// ---- 会话（Redis 优先 + 内存兜底） ----
void Store::putSession(const std::string& token, const std::string& username, uint32_t ttlSec) {
  memory_->putSession(token, username, ttlSec);
  if (redis_) redis_->putSession(token, username, ttlSec);
}
std::string Store::getSession(const std::string& token) {
  if (redis_) {
    std::string u = redis_->getSession(token);
    if (!u.empty()) return u;
    // Redis 未命中可能是过期：清理内存侧（可选）
  }
  return memory_->getSession(token);
}
void Store::delSession(const std::string& token) {
  memory_->delSession(token);
  if (redis_) redis_->delSession(token);
}

// ---- 通用缓存 ----
void Store::cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec) {
  memory_->cacheSet(key, val, ttlSec);
  if (redis_) redis_->cacheSet(key, val, ttlSec);
}
bool Store::cacheGet(const std::string& key, std::string& out) {
  if (redis_ && redis_->cacheGet(key, out)) return true;
  return memory_->cacheGet(key, out);
}
void Store::cacheDel(const std::string& key) {
  memory_->cacheDel(key);
  if (redis_) redis_->cacheDel(key);
}

} // namespace ew
