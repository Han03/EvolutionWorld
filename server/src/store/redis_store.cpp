// redis_store.cpp - Redis RESP 客户端实现（纯 socket，无第三方依赖）
#include "redis_store.h"
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <algorithm>
namespace ew {
namespace {
constexpr int kCmdTimeoutMs = 2000;
// 非阻塞连接：poll 等待可写，实现连接超时
int tcpConnect(const std::string& host, int port, int timeoutMs) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res) return -1;
  int fd = -1;
  for (addrinfo* p = res; p; p = p->ai_next) {
    fd = socket(p->ai_family, p->ai_socktype | SOCK_NONBLOCK, p->ai_protocol);
    if (fd < 0) continue;
    int rc = connect(fd, p->ai_addr, p->ai_addrlen);
    if (rc == 0) break;
    if (errno == EINPROGRESS) {
      pollfd pf{fd, POLLOUT, 0};
      int pr = poll(&pf, 1, timeoutMs);
      if (pr > 0 && (pf.revents & POLLOUT)) {
        int err = 0;
        socklen_t el = sizeof(err);
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el);
        if (err == 0) break;
      }
    }
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd >= 0) {
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    int fl = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, fl & ~O_NONBLOCK); // 恢复阻塞，靠 poll 做读超时
  }
  return fd;
}
} // namespace

bool RedisClient::connect(const std::string& host, int port, const std::string& pass, int timeoutMs) {
  close();
  fd_ = tcpConnect(host, port, timeoutMs);
  if (fd_ < 0) return false;
  if (!pass.empty()) {
    std::string rep; char t;
    if (!command({"AUTH", pass}, rep, t) || t != '+') { close(); return false; }
  }
  std::string rep; char t;
  if (!command({"PING"}, rep, t) || t != '+') { close(); return false; }
  return true;
}
void RedisClient::close() {
  if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
}
bool RedisClient::writeAll(const std::string& data) {
  size_t off = 0;
  while (off < data.size()) {
    ssize_t n = ::send(fd_, data.data() + off, data.size() - off, 0);
    if (n < 0) { if (errno == EINTR) continue; return false; }
    off += (size_t)n;
  }
  return true;
}
bool RedisClient::readLine(std::string& line) {
  line.clear();
  char c;
  while (true) {
    ssize_t n = ::recv(fd_, &c, 1, 0);
    if (n == 1) {
      if (c == '\n') return true;
      if (c != '\r') line += c;
    } else if (n == 0) {
      return false;
    } else if (errno == EINTR) {
      continue;
    } else {
      return false;
    }
  }
}
bool RedisClient::readBytes(size_t n, std::string& out) {
  out.clear();
  out.reserve(n);
  char buf[4096];
  while (out.size() < n) {
    size_t want = std::min(sizeof(buf), n - out.size());
    ssize_t r = ::recv(fd_, buf, want, 0);
    if (r > 0) out.append(buf, (size_t)r);
    else if (r == 0) return false;
    else if (errno != EINTR) return false;
  }
  return true;
}
bool RedisClient::command(const std::vector<std::string>& args, std::string& reply, char& replyType) {
  if (fd_ < 0) return false;
  // 组装 RESP 数组
  std::string req = "*" + std::to_string(args.size()) + "\r\n";
  for (const auto& a : args) {
    req += "$" + std::to_string(a.size()) + "\r\n" + a + "\r\n";
  }
  if (!writeAll(req)) { close(); return false; }
  // 读回复（含类型前缀，交给调用方解析）
  char buf[1];
  ssize_t n = ::recv(fd_, buf, 1, 0);
  if (n != 1) { close(); return false; }
  replyType = buf[0];
  if (replyType == '+') {
    std::string line;
    if (!readLine(line)) { close(); return false; }
    reply = line;
  } else if (replyType == '-') {
    std::string line;
    if (!readLine(line)) { close(); return false; }
    reply = line; // 错误信息；调用方按需处理
  } else if (replyType == ':') {
    std::string line;
    if (!readLine(line)) { close(); return false; }
    reply = line;
  } else if (replyType == '$') {
    std::string line;
    if (!readLine(line)) { close(); return false; }
    long len = strtol(line.c_str(), nullptr, 10);
    if (len < 0) { reply.clear(); return true; } // nil
    std::string data;
    if (!readBytes((size_t)len, data)) { close(); return false; }
    // 吃掉尾部 \r\n
    char tail[2];
    if (::recv(fd_, tail, 2, 0) != 2) { close(); return false; }
    reply = data;
  } else if (replyType == '*') {
    std::string line;
    if (!readLine(line)) { close(); return false; }
    long count = strtol(line.c_str(), nullptr, 10);
    // 简单数组：依次读各元素（仅当用于 MULTI 等；本客户端不使用嵌套数组）
    std::string acc;
    for (long i = 0; i < count; i++) {
      std::string el; char t2;
      if (!command({}, el, t2)) return false; // 递归读子回复（无参数命令不允许，这里直接读）
    }
    reply = line;
  } else {
    close();
    return false;
  }
  return true;
}

bool RedisClient::ping() {
  std::string r; char t;
  return command({"PING"}, r, t) && t == '+';
}
bool RedisClient::set(const std::string& key, const std::string& val, uint32_t ttlSec) {
  std::string r; char t;
  std::vector<std::string> args = {"SET", key, val};
  if (ttlSec > 0) { args.push_back("EX"); args.push_back(std::to_string(ttlSec)); }
  return command(args, r, t) && t == '+';
}
bool RedisClient::get(const std::string& key, std::string& out) {
  std::string r; char t;
  if (!command({"GET", key}, r, t) || t != '$') return false;
  out = r;
  return true;
}
bool RedisClient::del(const std::string& key) {
  std::string r; char t;
  return command({"DEL", key}, r, t) && t == ':';
}
bool RedisClient::exists(const std::string& key) {
  std::string r; char t;
  return command({"EXISTS", key}, r, t) && t == ':' && r != "0";
}
bool RedisClient::expire(const std::string& key, uint32_t ttlSec) {
  std::string r; char t;
  return command({"EXPIRE", key, std::to_string(ttlSec)}, r, t) && t == ':';
}

// ---------- RedisStore（IStore） ----------
bool RedisStore::init() {
  available_ = client_.connect(sc_.redisHost, sc_.redisPort, sc_.redisPass, 2000);
  return available_;
}
bool RedisStore::putSession(const std::string& token, const std::string& username, uint32_t ttlSec) {
  if (!available_) return false;
  bool ok = client_.set(key("sess:" + token), username, ttlSec);
  if (!ok) { available_ = false; }
  return ok;
}
std::string RedisStore::getSession(const std::string& token) {
  if (!available_) return "";
  std::string out;
  bool ok = client_.get(key("sess:" + token), out);
  if (!ok) { available_ = false; return ""; }
  return out;
}
bool RedisStore::delSession(const std::string& token) {
  if (!available_) return false;
  bool ok = client_.del(key("sess:" + token));
  if (!ok) { available_ = false; }
  return ok;
}
bool RedisStore::cacheSet(const std::string& k, const std::string& v, uint32_t ttlSec) {
  if (!available_) return false;
  bool ok = client_.set(key("cache:" + k), v, ttlSec);
  if (!ok) { available_ = false; }
  return ok;
}
bool RedisStore::cacheGet(const std::string& k, std::string& out) {
  if (!available_) return false;
  bool ok = client_.get(key("cache:" + k), out);
  if (!ok) { available_ = false; }
  return ok;
}
bool RedisStore::cacheDel(const std::string& k) {
  if (!available_) return false;
  bool ok = client_.del(key("cache:" + k));
  if (!ok) { available_ = false; }
  return ok;
}
} // namespace ew
