// server.cpp - epoll 事件循环实现（单线程：HTTP + WebSocket + 游戏 tick）
#include "server.h"
#include "websocket.h"
#include "http.h"
#include <sys/socket.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <cerrno>
#include <chrono>
#include <fstream>
#include <cstdlib>
#include <cmath>

namespace ew {

uint64_t GameServer::steadyMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch()).count();
}

static int setNonBlocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

bool GameServer::start() {
  listenFd_ = socket(AF_INET, SOCK_STREAM, 0);
  if (listenFd_ < 0) return false;
  int one = 1;
  setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  setNonBlocking(listenFd_);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port = htons((uint16_t)cfg_.port);
  if (bind(listenFd_, (sockaddr*)&addr, sizeof(addr)) < 0) return false;
  if (listen(listenFd_, 64) < 0) return false;

  epollFd_ = epoll_create1(0);
  if (epollFd_ < 0) return false;
  epoll_event ev{};
  ev.events = EPOLLIN;
  ev.data.fd = listenFd_;
  epoll_ctl(epollFd_, EPOLL_CTL_ADD, listenFd_, &ev);

  running_ = true;
  nextTickMs_ = steadyMs();
  return true;
}

void GameServer::run() {
  epoll_event events[128];
  while (running_) {
    uint64_t now = steadyMs();
    int timeout = (now < nextTickMs_) ? (int)(nextTickMs_ - now) : 1;
    int n = epoll_wait(epollFd_, events, 128, timeout);
    if (getenv("EW_TICKDBG")) {
      static uint64_t lastLog = 0;
      static uint64_t loopCount = 0, eventCount = 0;
      loopCount++;
      if (n > 0) eventCount++;
      if (now - lastLog > 2000) {
        double dts = (double)(now - lastLog) / 1000.0;
        fprintf(stderr, "[LOOP] %.0f/s iters, %.0f/s event-iters, conns=%zu\n",
                (double)loopCount / dts, (double)eventCount / dts, conns_.size());
        lastLog = now; loopCount = 0; eventCount = 0;
      }
    }
    if (n < 0) {
      if (errno == EINTR) continue;
      break;
    }
    for (int i = 0; i < n; i++) {
      int fd = events[i].data.fd;
      if (fd == listenFd_) {
        acceptNew();
        continue;
      }
      auto it = conns_.find(fd);
      if (it == conns_.end()) continue;
      if (events[i].events & (EPOLLERR | EPOLLHUP)) { closeConn(fd); continue; }
      if (events[i].events & EPOLLIN) {
        onReadable(it->second);
        // onReadable 可能已关闭该连接，重新查找避免悬垂引用
        it = conns_.find(fd);
        if (it == conns_.end()) continue;
      }
      if (events[i].events & EPOLLOUT) {
        onWritable(it->second);
        it = conns_.find(fd);
        if (it == conns_.end()) continue;
      }
      if (it->second.closeAfterFlush && it->second.outBuf.empty()) {
        closeConn(fd);
      }
    }

    // 游戏 tick（对齐 20Hz）
    now = steadyMs();
    if (now >= nextTickMs_) {
      if (getenv("EW_TICKDBG")) {
        static uint64_t lastLog = 0;
        static uint64_t lastTick = 0;
        if (now - lastLog > 2000) {
          fprintf(stderr, "[TICK] %llu ticks in %llums (~%.0f/s)\n",
                  (unsigned long long)(world_.tickCount() - lastTick),
                  (unsigned long long)(now - lastLog),
                  (double)(world_.tickCount() - lastTick) * 1000.0 / (double)(now - lastLog));
          lastLog = now; lastTick = world_.tickCount();
        }
      }
      world_.tick();
      broadcastSnapshots();
      nextTickMs_ += (uint64_t)cfg_.tickMs;
      // 仅当真正落后超过一个 tick 时才重同步（防止无符号减法下溢造成空转）
      uint64_t sNow = steadyMs();
      if (sNow > nextTickMs_ && sNow - nextTickMs_ > (uint64_t)cfg_.tickMs) {
        nextTickMs_ = sNow;
      }
    }
  }
}

void GameServer::stop() { running_ = false; }

void GameServer::acceptNew() {
  while (true) {
    sockaddr_in peer{};
    socklen_t plen = sizeof(peer);
    int fd = accept(listenFd_, (sockaddr*)&peer, &plen);
    if (fd < 0) break;
    setNonBlocking(fd);
    Conn c;
    c.fd = fd;
    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = fd;
    epoll_ctl(epollFd_, EPOLL_CTL_ADD, fd, &ev);
    conns_[fd] = std::move(c);
  }
}

void GameServer::closeConn(int fd) {
  auto it = conns_.find(fd);
  if (it != conns_.end()) {
    Conn& c = it->second;
    if (!c.playerId.empty()) {
      Entity* e = world_.findEntity(c.playerId);
      if (e) ac_.reset(*e);
      world_.despawnPlayer(c.playerId);
    }
    epoll_ctl(epollFd_, EPOLL_CTL_DEL, fd, nullptr);
    conns_.erase(it);
  }
  close(fd);
}

void GameServer::enqueue(Conn& c, const std::string& data) {
  if (data.empty() || c.fd < 0) return;
  bool wasEmpty = c.outBuf.empty();
  c.outBuf += data;
  if (wasEmpty && !c.outWatching) {
    epoll_event ev{};
    ev.events = EPOLLIN | EPOLLOUT;
    ev.data.fd = c.fd;
    epoll_ctl(epollFd_, EPOLL_CTL_MOD, c.fd, &ev);
    c.outWatching = true;
  }
}

void GameServer::onWritable(Conn& c) {
  while (!c.outBuf.empty()) {
    ssize_t w = send(c.fd, c.outBuf.data(), c.outBuf.size(), 0);
    if (w < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      c.outBuf.clear();
      closeConn(c.fd); // 注意：调用后外层需重新查找 fd
      return;
    }
    c.outBuf.erase(0, (size_t)w);
  }
  if (c.outWatching) {
    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = c.fd;
    epoll_ctl(epollFd_, EPOLL_CTL_MOD, c.fd, &ev);
    c.outWatching = false;
  }
  // 关闭动作统一由事件循环外层处理（closeAfterFlush && outBuf 已空）
}

void GameServer::onReadable(Conn& c) {
  char buf[16384];
  while (true) {
    ssize_t r = recv(c.fd, buf, sizeof(buf), 0);
    if (r > 0) {
      c.inBuf.append(buf, (size_t)r);
      if ((size_t)r < sizeof(buf)) break;
    } else if (r == 0) {
      c.closeAfterFlush = false;
      c.inBuf.clear();
      closeConn(c.fd);
      return;
    } else {
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      closeConn(c.fd);
      return;
    }
  }

  if (c.phase == Conn::Http) {
    while (!c.inBuf.empty() && c.phase == Conn::Http) {
      size_t consumed = 0;
      HttpRequest req;
      if (!httpParseRequest(c.inBuf, consumed, req)) break;
      c.inBuf.erase(0, consumed);
      handleHttp(c, req);
    }
  } else if (c.phase == Conn::Ws) {
    while (!c.inBuf.empty() && c.phase == Conn::Ws) {
      size_t consumed = 0;
      bool fin = false;
      int opcode = 0;
      std::string payload;
      if (!wsDecodeFrame(c.inBuf, consumed, fin, opcode, payload)) break;
      c.inBuf.erase(0, consumed);
      handleWsFrame(c, fin, opcode, payload);
    }
  }
}

// ---------------- HTTP ----------------

static std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f.is_open()) return "";
  std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  return s;
}

void GameServer::handleHttp(Conn& c, const HttpRequest& req) {
  auto& path = req.path;

  // ---- WebSocket 升级 ----
  if (path == "/ws" && req.method == "GET") {
    auto up = req.headers.find("upgrade");
    if (up != req.headers.end() && up->second.find("websocket") != std::string::npos) {
      auto keyIt = req.headers.find("sec-websocket-key");
      if (keyIt != req.headers.end()) {
        std::string token = queryParam(req.query, "token");
        std::string username = auth_.verifyToken(token);
        if (username.empty()) {
          std::string err = "{\"type\":\"error\",\"message\":\"invalid token\"}";
          enqueue(c, wsEncodeFrame(WS_TEXT, err));
          enqueue(c, wsEncodeFrame(WS_CLOSE, ""));
          c.closeAfterFlush = true;
          return;
        }
        Entity* player = world_.spawnPlayer(username);
        c.playerId = player->id;
        c.phase = Conn::Ws;
        c.inBuf.clear();
        // 先回 101，再发 welcome 帧（顺序必须如此）
        enqueue(c, httpBuildUpgrade(wsAcceptKey(keyIt->second)));
        Json w = Json::object();
        w["type"] = "welcome";
        w["entityId"] = player->id;
        w["username"] = player->username;
        Json wc = Json::object();
        wc["seed"] = cfg_.worldSeed;
        wc["viewRange"] = cfg_.viewRangeM;
        wc["chunkSize"] = cfg_.chunkSizeM;
        wc["tickRate"] = cfg_.tickRateHz;
        w["world"] = wc;
        w["you"] = player->serialize();
        enqueue(c, wsEncodeFrame(WS_TEXT, w.dump()));
        return;
      }
    }
    enqueue(c, httpBuildResponse(400, "Bad Request", "text/plain", "bad ws handshake"));
    c.closeAfterFlush = true;
    return;
  }

  // ---- API ----
  if (path == "/api/health" && req.method == "GET") {
    Json j = Json::object();
    j["ok"] = true;
    j["name"] = "EvolutionWorld";
    j["ts"] = (int64_t)steadyMs();
    enqueue(c, httpBuildResponse(200, "OK", "application/json", j.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/register" && req.method == "POST") {
    Json r;
    int code;
    try {
      Json in = Json::parse(req.body);
      r = auth_.registerUser(in.at("username").asString(), in.at("password").asString());
      code = r.at("ok").asBool() ? 200 : 400;
    } catch (...) {
      r = Json::object(); r["ok"] = false; r["error"] = "请求格式错误";
      code = 400;
    }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Bad Request", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/login" && req.method == "POST") {
    Json r;
    int code;
    try {
      Json in = Json::parse(req.body);
      r = auth_.login(in.at("username").asString(), in.at("password").asString());
      code = r.at("ok").asBool() ? 200 : 401;
    } catch (...) {
      r = Json::object(); r["ok"] = false; r["error"] = "请求格式错误";
      code = 400;
    }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Unauthorized", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/logout" && req.method == "POST") {
    try {
      Json in = Json::parse(req.body);
      auth_.logout(in.at("token").asString());
    } catch (...) {}
    Json r = Json::object(); r["ok"] = true;
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/debug/players" && req.method == "GET" && getenv("EW_DEBUG")) {
    Json arr = Json::array();
    for (const auto& pid : world_.players()) {
      const Entity* p = world_.findEntity(pid);
      if (!p) continue;
      Json j = Json::object();
      j["id"] = p->id;
      j["username"] = p->username;
      j["x"] = p->pos.x; j["y"] = p->pos.y; j["z"] = p->pos.z;
      j["vx"] = p->vel.x; j["vz"] = p->vel.z;
      j["grounded"] = p->grounded;
      arr.push_back(j);
    }
    Json r = Json::object();
    r["tick"] = (int64_t)world_.tickCount();
    r["players"] = arr;
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }

  // ---- 静态资源（客户端） ----
  if (req.method == "GET") {
    std::string rel = urlDecode(path);
    if (rel.find("..") != std::string::npos || rel.find('\0') != std::string::npos) {
      enqueue(c, httpBuildResponse(403, "Forbidden", "text/plain", "forbidden"));
      c.closeAfterFlush = true;
      return;
    }
    if (rel == "/" || rel.empty()) rel = "/index.html";
    std::string full = cfg_.clientDir + rel;
    std::string content = readFile(full);
    if (content.empty()) {
      full = cfg_.clientDir + "/index.html"; // SPA 回退
      content = readFile(full);
    }
    if (!content.empty()) {
      enqueue(c, httpBuildResponse(200, "OK", mimeType(rel), content));
    } else {
      enqueue(c, httpBuildResponse(404, "Not Found", "text/plain", "not found"));
    }
    c.closeAfterFlush = true;
    return;
  }

  enqueue(c, httpBuildResponse(405, "Method Not Allowed", "text/plain", "method not allowed"));
  c.closeAfterFlush = true;
}

// ---------------- WebSocket ----------------

void GameServer::handleWsFrame(Conn& c, bool fin, int opcode, const std::string& payload) {
  switch (opcode) {
    case WS_PING:
      enqueue(c, wsEncodeFrame(WS_PONG, payload));
      return;
    case WS_PONG:
      return;
    case WS_CLOSE:
      enqueue(c, wsEncodeFrame(WS_CLOSE, ""));
      c.closeAfterFlush = true;
      return;
    case WS_TEXT:
    case WS_BINARY:
      if (fin) {
        handleWsMessage(c, payload);
      } else {
        c.wsPartial = payload;
        c.wsFragmented = true;
      }
      return;
    case 0:
      if (c.wsFragmented) {
        c.wsPartial += payload;
        if (fin) {
          std::string msg = c.wsPartial;
          c.wsPartial.clear();
          c.wsFragmented = false;
          handleWsMessage(c, msg);
        }
      }
      return;
    default:
      return;
  }
}

void GameServer::handleWsMessage(Conn& c, const std::string& msg) {
  if (msg.size() > (size_t)cfg_.maxInputBodyLen) return;
  Json j;
  try {
    j = Json::parse(msg);
  } catch (...) {
    return;
  }
  std::string type = j.at("type").isNull() ? "" : j.at("type").asString();
  if (type == "input") {
    Entity* p = world_.findEntity(c.playerId);
    if (!p) return;
    AntiCheatResult res = ac_.process(*p, j, steadyMs());
    if (res.kick) {
      Json k = Json::object();
      k["type"] = "kick";
      k["reason"] = res.reason;
      sendTo(c, k);
      enqueue(c, wsEncodeFrame(WS_CLOSE, ""));
      c.closeAfterFlush = true;
      return;
    }
    if (res.correction) {
      // 服务端后校验不通过 → 回退：把客户端拉回服务端权威位置
      Json corr = Json::object();
      corr["type"] = "correction";
      corr["reason"] = res.reason;
      corr["x"] = p->pos.x;
      corr["y"] = p->pos.y;
      corr["z"] = p->pos.z;
      sendTo(c, corr);
    }
    if (getenv("EW_DEBUG")) {
      fprintf(stderr, "[AC] %s reason=%s %s\n", p->id.c_str(), res.reason.c_str(),
              res.accepted ? "accepted" : "rejected");
    }
  }
}

void GameServer::sendTo(Conn& c, const Json& j) {
  enqueue(c, wsEncodeFrame(WS_TEXT, j.dump()));
}

int GameServer::fdOfPlayer(const std::string& playerId) const {
  for (const auto& [fd, c] : conns_) {
    if (c.playerId == playerId) return fd;
  }
  return -1;
}

void GameServer::broadcastSnapshots() {
  for (const auto& pid : world_.players()) {
    const Entity* player = world_.findEntity(pid);
    if (!player) continue;
    int fd = fdOfPlayer(player->id);
    if (fd < 0) continue;
    auto it = conns_.find(fd);
    if (it == conns_.end() || it->second.phase != Conn::Ws) continue;
    Json snap = world_.buildSnapshot(*player);
    enqueue(it->second, wsEncodeFrame(WS_TEXT, snap.dump()));
  }
}

} // namespace ew
