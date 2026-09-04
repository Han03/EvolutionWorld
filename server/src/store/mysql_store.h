// mysql_store.h - MySQL 存储后端（libmysqlclient）
// 用于：账号持久化 + 玩家存档持久化。仅在编译期检测到 MySQL 头文件时启用（EW_HAVE_MYSQL）。
// 连接失败/断线 → available()=false，由 Store 门面自动降级到内存，不影响功能。
#pragma once
#include "store.h"
#include <string>
#include <memory>

namespace ew {

class MysqlImpl; // Pimpl：隔离 mysql.h，未编译 MySQL 时也无需头文件

class MysqlStore : public IStore {
public:
  explicit MysqlStore(const StoreConfig& sc);
  ~MysqlStore() override;
  MysqlStore(const MysqlStore&) = delete;
  MysqlStore& operator=(const MysqlStore&) = delete;

  bool init();  // 连接 + 建表（失败返回 false）
  bool available() const override;
  const char* backendName() const override { return "mysql"; }

  bool upsertUser(const UserRecord& u) override;
  bool getUser(const std::string& username, UserRecord& out) override;
  bool userExists(const std::string& username) override;
  // 全量加载账号（供启动时灌入内存缓存）
  std::vector<UserRecord> loadAllUsers();

  bool savePlayer(const PlayerSave& s) override;
  bool loadPlayer(const std::string& username, PlayerSave& out) override;

  // 世界数据（地形 mask + 出生点）持久化（world_data 表）
  bool saveWorldData(const std::string& key, const std::string& val) override;
  bool loadWorldData(const std::string& key, std::string& out) override;

  bool putSession(const std::string&, const std::string&, uint32_t) override { return false; } // 会话走 Redis
  std::string getSession(const std::string&) override { return ""; }
  bool delSession(const std::string&) override { return false; }
  bool cacheSet(const std::string&, const std::string&, uint32_t) override { return false; }    // 缓存走 Redis
  bool cacheGet(const std::string&, std::string&) override { return false; }
  bool cacheDel(const std::string&) override { return false; }

  // ---- 社交系统：好友 ----
  bool addFriend(const std::string& a, const std::string& b) override;
  bool removeFriend(const std::string& a, const std::string& b) override;
  std::vector<std::pair<std::string, uint64_t>> loadFriends(const std::string& username) override;
  bool addBlock(const std::string& a, const std::string& b) override;
  bool removeBlock(const std::string& a, const std::string& b) override;
  std::vector<std::string> loadBlocks(const std::string& username) override;

  // ---- 社交系统：公会 ----
  bool saveGuild(const GuildSave& g) override;
  bool loadGuild(uint32_t guildId, GuildSave& out) override;
  bool deleteGuild(uint32_t guildId) override;
  bool saveGuildMembers(uint32_t guildId, const std::string& membersJson) override;
  std::string loadGuildMembers(uint32_t guildId) override;
  std::vector<uint32_t> loadAllGuildIds() override;

  // ---- 任务系统 ----
  bool saveQuests(const std::string& username, const std::string& questsJson) override;
  std::string loadQuests(const std::string& username) override;

  // ---- 批量加载（启动时填充内存后端用）----
  std::vector<std::tuple<std::string, std::string, uint64_t>> loadAllFriends();
  std::vector<std::pair<std::string, std::string>> loadAllBlocks();
  std::vector<std::pair<uint32_t, std::string>> loadAllGuildMembers();

private:
  StoreConfig sc_;
  std::unique_ptr<MysqlImpl> impl_;
};

} // namespace ew
