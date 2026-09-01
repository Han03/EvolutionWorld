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

  bool putSession(const std::string&, const std::string&, uint32_t) override { return false; } // 会话走 Redis
  std::string getSession(const std::string&) override { return ""; }
  bool delSession(const std::string&) override { return false; }
  bool cacheSet(const std::string&, const std::string&, uint32_t) override { return false; }    // 缓存走 Redis
  bool cacheGet(const std::string&, std::string&) override { return false; }
  bool cacheDel(const std::string&) override { return false; }

private:
  StoreConfig sc_;
  std::unique_ptr<MysqlImpl> impl_;
};

} // namespace ew
