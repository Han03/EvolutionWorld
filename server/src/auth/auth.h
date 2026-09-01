// auth.h - 账号鉴权（注册/登录/会话令牌）
#pragma once
#include <string>
#include <unordered_map>
#include <cstdint>
#include "util/json.h"
#include "../config.h"

namespace ew {

struct User { std::string username, salt, hash, createdAt; };

class Auth {
public:
  explicit Auth(const Config& cfg);

  // 返回 { ok, error? , user? }
  Json registerUser(const std::string& username, const std::string& password);
  // 返回 { ok, token?, user? }
  Json login(const std::string& username, const std::string& password);
  // 校验令牌；返回 username 或空串
  std::string verifyToken(const std::string& token);
  void logout(const std::string& token);

private:
  void load();
  void save();
  std::string hashPassword(const std::string& password, const std::string& salt) const;

  const Config& cfg_;
  std::unordered_map<std::string, User> users_;
  struct Session { std::string userId, username; uint64_t expiresAtMs; };
  std::unordered_map<std::string, Session> sessions_;
};

} // namespace ew
