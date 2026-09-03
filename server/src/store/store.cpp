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

  // ---- 社交系统：好友 ----
  bool addFriend(const std::string& a, const std::string& b) override {
    friends_[a].push_back({b, nowMs()});
    friends_[b].push_back({a, nowMs()});
    return true;
  }
  bool removeFriend(const std::string& a, const std::string& b) override {
    auto removeFrom = [&](const std::string& from, const std::string& target) {
      auto& vec = friends_[from];
      vec.erase(std::remove_if(vec.begin(), vec.end(),
          [&](const auto& p) { return p.first == target; }), vec.end());
    };
    removeFrom(a, b);
    removeFrom(b, a);
    return true;
  }
  std::vector<std::pair<std::string, uint64_t>> loadFriends(const std::string& username) override {
    auto it = friends_.find(username);
    if (it == friends_.end()) return {};
    return it->second;
  }
  bool addBlock(const std::string& a, const std::string& b) override {
    blocks_[a].push_back(b);
    return true;
  }
  bool removeBlock(const std::string& a, const std::string& b) override {
    auto& vec = blocks_[a];
    vec.erase(std::remove(vec.begin(), vec.end(), b), vec.end());
    return true;
  }
  std::vector<std::string> loadBlocks(const std::string& username) override {
    auto it = blocks_.find(username);
    if (it == blocks_.end()) return {};
    return it->second;
  }

  // ---- 社交系统：公会 ----
  bool saveGuild(const GuildSave& g) override { guilds_[g.guildId] = g; return true; }
  bool loadGuild(uint32_t guildId, GuildSave& out) override {
    auto it = guilds_.find(guildId);
    if (it == guilds_.end()) return false;
    out = it->second;
    return true;
  }
  bool deleteGuild(uint32_t guildId) override { guilds_.erase(guildId); return true; }
  bool saveGuildMembers(uint32_t guildId, const std::string& membersJson) override {
    guildMembers_[guildId] = membersJson;
    return true;
  }
  std::string loadGuildMembers(uint32_t guildId) override {
    auto it = guildMembers_.find(guildId);
    if (it == guildMembers_.end()) return "";
    return it->second;
  }
  std::vector<uint32_t> loadAllGuildIds() override {
    std::vector<uint32_t> ids;
    for (const auto& [id, _] : guilds_) ids.push_back(id);
    return ids;
  }
  // 任务系统内存存储
  bool saveQuests(const std::string& username, const std::string& questsJson) override {
    playerQuests_[username] = questsJson;
    return true;
  }
  std::string loadQuests(const std::string& username) override {
    auto it = playerQuests_.find(username);
    return it == playerQuests_.end() ? "" : it->second;
  }

  // ---- 世界数据（内存模式：进程内保存，重启丢失 → 每次启动重新初始化）----
  bool saveWorldData(const std::string& key, const std::string& val) override {
    world_[key] = val;
    return true;
  }
  bool loadWorldData(const std::string& key, std::string& out) override {
    auto it = world_.find(key);
    if (it == world_.end()) return false;
    out = it->second;
    return true;
  }

  // 供 Store 门面在降级/路由时访问
  const std::unordered_map<std::string, UserRecord>& users() const { return users_; }
  std::unordered_map<std::string, UserRecord>& usersMut() { return users_; }

private:
  std::unordered_map<std::string, UserRecord> users_;
  std::unordered_map<std::string, PlayerSave> saves_;
  std::unordered_map<std::string, MemSession> sessions_;
  std::unordered_map<std::string, MemCacheEntry> cache_;
  // 社交系统内存存储
  std::unordered_map<std::string, std::vector<std::pair<std::string, uint64_t>>> friends_; // username -> [(friend, sinceMs)]
  std::unordered_map<std::string, std::vector<std::string>> blocks_; // username -> [blocked...]
  std::unordered_map<uint32_t, GuildSave> guilds_;
  std::unordered_map<uint32_t, std::string> guildMembers_; // guildId -> membersJson
  std::unordered_map<std::string, std::string> playerQuests_; // username -> questsJson
  std::unordered_map<std::string, std::string> world_;        // key -> 世界数据 JSON（mask+出生点）
};

// ============ 配置解析（环境变量） ============
// EW_CONFIG：按 "key1=value1,key2=value2,..." 的规则读取可接受配置（部署用，自托管 runner 连托管库）。
// 支持的 key（白名单，未知 key 忽略）：
//   mysql_host / mysql_port / mysql_user / mysql_pass / mysql_db
//   redis_host / redis_port / redis_pass / redis_prefix
// 优先级：EW_CONFIG 先行应用，单独的 EW_DB_MYSQL / EW_DB_REDIS 等环境变量可覆盖对应字段。
static void applyEwConfig(StoreConfig& sc) {
  const char* ew = getenv("EW_CONFIG");
  if (!ew || !*ew) return;
  std::string buf(ew);
  auto trim = [](const std::string& s) -> std::string {
    size_t b = s.find_first_not_of(" \t");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t");
    return s.substr(b, e - b + 1);
  };
  size_t pos = 0;
  while (pos <= buf.size()) {
    size_t comma = buf.find(',', pos);
    std::string pair = buf.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
    if (comma == std::string::npos) pos = buf.size() + 1; else pos = comma + 1;
    size_t eq = pair.find('=');
    if (eq == std::string::npos) continue;
    std::string k = trim(pair.substr(0, eq));
    std::string v = trim(pair.substr(eq + 1));
    if (k.empty() || v.empty()) continue;
    if (k == "mysql_host") sc.mysqlHost = v;
    else if (k == "mysql_port") sc.mysqlPort = atoi(v.c_str());
    else if (k == "mysql_user") sc.mysqlUser = v;
    else if (k == "mysql_pass") sc.mysqlPass = v;
    else if (k == "mysql_db") sc.mysqlDb = v;
    else if (k == "redis_host") sc.redisHost = v;
    else if (k == "redis_port") sc.redisPort = atoi(v.c_str());
    else if (k == "redis_pass") sc.redisPass = v;
    else if (k == "redis_prefix") sc.redisPrefix = v;
    // 未知 key：忽略（仅接受可接受配置）
  }
}
StoreConfig storeConfigFromEnv(const Config& cfg) {
  (void)cfg;
  StoreConfig sc;
  applyEwConfig(sc);   // EW_CONFIG 先应用（部署配置）
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

// ---- 社交系统：好友 ----
void Store::addFriend(const std::string& a, const std::string& b) {
  memory_->addFriend(a, b);
  if (mysql_) mysql_->addFriend(a, b);
}
void Store::removeFriend(const std::string& a, const std::string& b) {
  memory_->removeFriend(a, b);
  if (mysql_) mysql_->removeFriend(a, b);
}
std::vector<std::pair<std::string, uint64_t>> Store::loadFriends(const std::string& username) {
  auto result = memory_->loadFriends(username);
  if (!result.empty()) return result;
  if (mysql_) return mysql_->loadFriends(username);
  return {};
}
void Store::addBlock(const std::string& a, const std::string& b) {
  memory_->addBlock(a, b);
  if (mysql_) mysql_->addBlock(a, b);
}
void Store::removeBlock(const std::string& a, const std::string& b) {
  memory_->removeBlock(a, b);
  if (mysql_) mysql_->removeBlock(a, b);
}
std::vector<std::string> Store::loadBlocks(const std::string& username) {
  auto result = memory_->loadBlocks(username);
  if (!result.empty()) return result;
  if (mysql_) return mysql_->loadBlocks(username);
  return {};
}

// ---- 社交系统：公会 ----
void Store::saveGuild(const GuildSave& g) {
  memory_->saveGuild(g);
  if (mysql_) mysql_->saveGuild(g);
}
bool Store::loadGuild(uint32_t guildId, GuildSave& out) {
  if (mysql_ && mysql_->loadGuild(guildId, out)) return true;
  return memory_->loadGuild(guildId, out);
}
void Store::deleteGuild(uint32_t guildId) {
  memory_->deleteGuild(guildId);
  if (mysql_) mysql_->deleteGuild(guildId);
}
void Store::saveGuildMembers(uint32_t guildId, const std::string& membersJson) {
  memory_->saveGuildMembers(guildId, membersJson);
  if (mysql_) mysql_->saveGuildMembers(guildId, membersJson);
}
std::string Store::loadGuildMembers(uint32_t guildId) {
  if (mysql_) {
    auto result = mysql_->loadGuildMembers(guildId);
    if (!result.empty()) return result;
  }
  return memory_->loadGuildMembers(guildId);
}
std::vector<uint32_t> Store::loadAllGuildIds() {
  if (mysql_) {
    auto ids = mysql_->loadAllGuildIds();
    if (!ids.empty()) return ids;
  }
  return memory_->loadAllGuildIds();
}

// ---- 任务系统 ----
void Store::saveQuests(const std::string& username, const std::string& questsJson) {
  memory_->saveQuests(username, questsJson);
  if (mysql_) mysql_->saveQuests(username, questsJson);
}
std::string Store::loadQuests(const std::string& username) {
  if (mysql_) {
    std::string q = mysql_->loadQuests(username);
    if (!q.empty()) return q;
  }
  return memory_->loadQuests(username);
}

// ---- 世界数据（内存必写 + MySQL 尽力；读 MySQL 优先回退内存）----
bool Store::saveWorldData(const std::string& key, const std::string& val) {
  bool m = memory_->saveWorldData(key, val);
  bool x = mysql_ ? mysql_->saveWorldData(key, val) : false;
  return m || x;
}
bool Store::loadWorldData(const std::string& key, std::string& out) {
  if (mysql_ && mysql_->loadWorldData(key, out)) return true;
  return memory_->loadWorldData(key, out);
}

} // namespace ew
