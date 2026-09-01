// redis_store.h - Redis 存储后端（纯 socket RESP 客户端，无第三方依赖）
// 用于：会话令牌缓存（EXPIRE）、热点 KV 缓存。连接失败/断线 → available()=false，
// 由 Store 门面自动降级到内存，不影响功能。
#pragma once
#include "store.h"
#include <string>
#include <unordered_map>
#include <cstdint>

namespace ew {

// 轻量 RESP 客户端（命令子集：PING/AUTH/SELECT/SET/GET/DEL/EXPIRE/EXISTS）
class RedisClient {
public:
  RedisClient() = default;
  ~RedisClient() { close(); }
  // 连接（含 TCP 连接超时与命令超时）；成功返回 true
  bool connect(const std::string& host, int port, const std::string& pass, int timeoutMs = 2000);
  void close();
  bool isConnected() const { return fd_ >= 0; }
  // 基础命令
  bool ping();
  bool set(const std::string& key, const std::string& val, uint32_t ttlSec);
  bool get(const std::string& key, std::string& out);
  bool del(const std::string& key);
  bool exists(const std::string& key);
  bool expire(const std::string& key, uint32_t ttlSec);

private:
  // 发送命令数组并读取回复；reply 为原始回复体（不含类型前缀后的内容，按需解析）
  // 返回 false 表示连接异常（上层据此降级）
  bool command(const std::vector<std::string>& args, std::string& reply, char& replyType);
  bool writeAll(const std::string& data);
  bool readLine(std::string& line);
  bool readBytes(size_t n, std::string& out);

  int fd_ = -1;
  std::string prefix_; // 键前缀（由 Store 层追加，客户端不感知）
};

// Redis 后端（IStore 实现）
class RedisStore : public IStore {
public:
  explicit RedisStore(const StoreConfig& sc) : sc_(sc) {}
  bool init(); // 连接探测
  bool available() const override { return client_.isConnected() && available_; }
  const char* backendName() const override { return "redis"; }

  bool upsertUser(const UserRecord&) override { return false; }   // 账号不落 Redis
  bool getUser(const std::string&, UserRecord&) override { return false; }
  bool userExists(const std::string&) override { return false; }
  bool savePlayer(const PlayerSave&) override { return false; }   // 存档不落 Redis
  bool loadPlayer(const std::string&, PlayerSave&) override { return false; }

  bool putSession(const std::string& token, const std::string& username, uint32_t ttlSec) override;
  std::string getSession(const std::string& token) override;
  bool delSession(const std::string& token) override;
  bool cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec) override;
  bool cacheGet(const std::string& key, std::string& out) override;
  bool cacheDel(const std::string& key) override;

private:
  std::string key(const std::string& k) const { return sc_.redisPrefix + k; }
  StoreConfig sc_;
  RedisClient client_;
  bool available_ = false;
};

} // namespace ew
