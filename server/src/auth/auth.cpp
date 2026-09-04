// auth.cpp - 鉴权实现（SHA-256 加盐哈希，OpenSSL）
// 文件持久化已移除：内存模式启动即空白；数据库模式由 MySQL 灌入账号。
#include "auth.h"
#include "util/random.h"
#include <openssl/sha.h>
#include <cstdio>
#include <ctime>
#include <regex>

namespace ew {

Auth::Auth(const Config& cfg, Store& store) : cfg_(cfg), store_(store) {
  // 若 MySQL 可用，启动时把 MySQL 账号合并进内存（跨进程/跨重启持久）
  for (const auto& u : store_.mysqlLoadAllUsers())
    users_[u.username] = User{u.username, u.salt, u.hash, u.createdAt};
}

std::string Auth::hashPassword(const std::string& password, const std::string& salt) const {
  // 简单加盐 SHA-256 双轮（空壳阶段够用；生产可换 scrypt/argon2）
  std::string in = salt + ":" + password;
  unsigned char h1[SHA256_DIGEST_LENGTH];
  SHA256((const unsigned char*)in.data(), in.size(), h1);
  SHA256(h1, SHA256_DIGEST_LENGTH, h1);
  static const char* HEX = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (unsigned char c : h1) { out += HEX[c >> 4]; out += HEX[c & 0xF]; }
  return out;
}

Json Auth::registerUser(const std::string& username, const std::string& password) {
  std::string uname = username;
  // 去首尾空白
  while (!uname.empty() && (uname.front() == ' ' || uname.front() == '\t')) uname.erase(uname.begin());
  while (!uname.empty() && (uname.back() == ' ' || uname.back() == '\t')) uname.pop_back();

  if (uname.size() < 2 || uname.size() > 16 ||
      !std::regex_match(uname, std::regex("^[a-zA-Z0-9_\u4e00-\u9fa5]+$"))) {
    Json r = Json::object();
    r["ok"] = false;
    r["error"] = "用户名需为 2-16 位字母/数字/下划线/中文";
    return r;
  }
  if (password.size() < 6 || password.size() > 64) {
    Json r = Json::object();
    r["ok"] = false;
    r["error"] = "密码长度需为 6-64 位";
    return r;
  }
  if (users_.count(uname)) {
    Json r = Json::object();
    r["ok"] = false;
    r["error"] = "用户名已存在";
    return r;
  }
  User u;
  u.username = uname;
  u.salt = randomHex(16);
  u.hash = hashPassword(password, u.salt);
  u.createdAt = "now";
  users_[uname] = u;
  // 同步到 MySQL（尽力而为；失败由 Store 自动降级，不影响功能）
  store_.upsertUser(UserRecord{u.username, u.salt, u.hash, u.createdAt});

  Json r = Json::object();
  r["ok"] = true;
  r["message"] = "注册成功，请登录";
  return r;
}

Json Auth::login(const std::string& username, const std::string& password) {
  std::string uname = username;
  while (!uname.empty() && (uname.front() == ' ' || uname.front() == '\t')) uname.erase(uname.begin());
  while (!uname.empty() && (uname.back() == ' ' || uname.back() == '\t')) uname.pop_back();

  auto it = users_.find(uname);
  Json fail = Json::object();
  fail["ok"] = false;
  fail["error"] = "用户名或密码错误";
  if (it == users_.end()) return fail;
  if (hashPassword(password, it->second.salt) != it->second.hash) return fail;

  std::string token = randomHex(24);
  Session s;
  s.userId = it->second.username;
  s.username = it->second.username;
  s.expiresAtMs = (uint64_t)time(nullptr) * 1000 + (uint64_t)cfg_.sessionTtlSec * 1000;
  sessions_[token] = s;

  Json r = Json::object();
  r["ok"] = true;
  r["token"] = token;
  Json u = Json::object();
  u["username"] = it->second.username;
  r["user"] = u;
  Json w = Json::object();
  w["seed"] = cfg_.worldSeed;
  w["viewRange"] = cfg_.viewRangeM;
  w["chunkSize"] = cfg_.chunkSizeM;
  w["tickRate"] = cfg_.tickRateHz;
  r["world"] = w;
  return r;
}

std::string Auth::verifyToken(const std::string& token) {
  if (token.empty()) return "";
  auto it = sessions_.find(token);
  if (it != sessions_.end()) {
    uint64_t nowMs = (uint64_t)time(nullptr) * 1000;
    if (it->second.expiresAtMs < nowMs) {
      sessions_.erase(it);
    } else {
      return it->second.username;
    }
  }
  // 内存未命中 → 尝试 Redis（其他实例签发的 token），命中则回填本地
  std::string uname = store_.getSession(token);
  if (!uname.empty()) {
    Session s;
    s.userId = uname;
    s.username = uname;
    s.expiresAtMs = (uint64_t)time(nullptr) * 1000 + (uint64_t)cfg_.sessionTtlSec * 1000;
    sessions_[token] = s;
    return uname;
  }
  return "";
}

void Auth::logout(const std::string& token) {
  sessions_.erase(token);
  store_.delSession(token);
}

} // namespace ew
