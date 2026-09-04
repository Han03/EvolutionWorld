// auth.h - 账号鉴权（注册/登录/会话令牌）
// 存储层：账号内存权威 + MySQL 持久化同步；会话内存 + Redis(EXPIRE) 缓存
// 文件持久化已移除：内存模式启动即空白，数据库模式由 MySQL 灌入账号。
#pragma once
#include <string>
#include <unordered_map>
#include <cstdint>
#include "util/json.h"
#include "../config.h"
#include "store/store.h"

namespace ew {

struct User { std::string username, salt, hash, createdAt; };

class Auth {
public:
  Auth(const Config& cfg, Store& store);

  // 返回 { ok, error? , user? }
  Json registerUser(const std::string& username, const std::string& password);
  // 返回 { ok, token?, user? }
  Json login(const std::string& username, const std::string& password);
  // 校验令牌；返回 username 或空串
  std::string verifyToken(const std::string& token);
  void logout(const std::string& token);

private:
  std::string hashPassword(const std::string& password, const std::string& salt) const;

  const Config& cfg_;
  Store& store_;
  std::unordered_map<std::string, User> users_;
  struct Session { std::string userId, username; uint64_t expiresAtMs; };
  std::unordered_map<std::string, Session> sessions_;
};

} // namespace ew
