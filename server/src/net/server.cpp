// server.cpp - epoll 事件循环实现（单线程：HTTP + WebSocket(二进制) + 游戏 tick）
#include "server.h"
#include "websocket.h"
#include "http.h"
#include "net/protocol.h"
#include "game/console.h"
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

// 物品系统持久化辅助（定义见文件后部）
static void applySaveItems(World& w, Entity& p, const PlayerSave& ps);

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

  // 游戏控制台：stdin 挂入 epoll（单线程内处理，不额外起线程）
  // 非 TTY（如后台运行/CI）时 fd 0 可能关闭，注册失败不影响服务
  int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (flags >= 0) {
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    ev.events = EPOLLIN;
    ev.data.fd = STDIN_FILENO;
    if (epoll_ctl(epollFd_, EPOLL_CTL_ADD, STDIN_FILENO, &ev) == 0) consoleReady_ = true;
  }

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
      if (fd == STDIN_FILENO) {  // 游戏控制台（stdin）
        handleStdinConsole();
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
      // 玩家复活：网络层补发 SELF 校正 + 强制校准快照（防作弊重置，避免复活瞬移被误判）
      for (const std::string& rid : world_.takeRespawnedPlayers()) {
        Entity* p = world_.findEntity(rid);
        if (!p) continue;
        ac_.reset(*p);
        p->violations = 0;
        p->acceptedInputs = 0;
        p->rateDrops = 0;
        int wfd = fdOfPlayer(p->id);
        if (wfd >= 0) {
          auto it = conns_.find(wfd);
          if (it != conns_.end() && it->second.phase == Conn::Ws) {
            sendTo(it->second, netcode_.correctionFrame(*p, "player_respawn", (uint32_t)world_.tickCount()));
            netcode_.requestResync(p->id);
          }
        }
      }
      broadcastTick();
      // 周期落玩家存档（每 100 tick ≈ 5s 一次；写失败由 Store 降级，不影响功能）
      if ((world_.tickCount() % 100) == 0) periodicSavePlayers();
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
      if (e) {
        ac_.reset(*e);
        savePlayerToStore(*e); // 下线落存档（MySQL/内存）
      }
      netcode_.resetPlayer(c.playerId);
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
        // 加载玩家存档（MySQL/内存；无存档则随机出生，不影响功能）
        Vec3 hint; bool hasSave = false;
        PlayerSave ps;
        if (store_.loadPlayer(username, ps)) {
          hint = {ps.x, ps.y, ps.z};
          hasSave = true;
        }
        Entity* player = world_.spawnPlayer(username, hasSave ? &hint : nullptr);
        if (hasSave) {
          player->hp = ps.hp > 0 && ps.hp <= player->maxHp ? ps.hp : player->maxHp;
          player->level = ps.level;
          player->pl.gold = ps.gold;
          applySaveItems(world_, *player, ps); // 恢复背包/装备（JSON）
          world_.recomputeStats(*player);
          fprintf(stderr, "[save] %s 从存档恢复位置 (%.1f,%.1f,%.1f) hp=%.0f gold=%u\n",
                  username.c_str(), ps.x, ps.y, ps.z, ps.hp, ps.gold);
        } else {
          world_.recomputeStats(*player); // 初始化派生属性（基础 + 空装备）
        }
        c.playerId = player->id;
        c.phase = Conn::Ws;
        c.inBuf.clear();
        // 先回 101，再发二进制 HELLO 帧（顺序必须如此）
        enqueue(c, httpBuildUpgrade(wsAcceptKey(keyIt->second)));
        enqueue(c, wsEncodeFrame(WS_BINARY, netcode_.helloFor(*player)));
        // 物品系统：登录即下发背包/装备/金币 + 自身属性（服务端权威）
        enqueue(c, wsEncodeFrame(WS_BINARY, proto::inventoryFrame(*player)));
        enqueue(c, wsEncodeFrame(WS_BINARY, proto::statsFrame(*player)));
        // 技能系统：登录即下发已学技能 + 冷却（服务端权威）
        enqueue(c, wsEncodeFrame(WS_BINARY, world_.skillsFrame(*player)));
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
      j["hp"] = p->hp; j["maxHp"] = p->maxHp;
      arr.push_back(j);
    }
    Json r = Json::object();
    r["tick"] = (int64_t)world_.tickCount();
    r["players"] = arr;
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }

  // 游戏控制台 HTTP 通道：POST /api/console {token, command}
  // 与 stdin / WS 通道共用 consoleExecute，便于脚本化功能测试（curl）
  if (path == "/api/console" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      Entity* p = username.empty() ? nullptr : world_.findPlayerByUsername(username);
      if (!p) { r["error"] = "no player"; code = 401; }
      else {
        std::string cmd = in.at("command").asString();
        ConsoleCtx ctx;
        ctx.world = &world_;
        ctx.playerId = p->id;
        std::string all;
        ctx.out = [&](const std::string& s) { all += s; all += "\n"; };
        bool known = consoleExecute(ctx, cmd);
        if (!known) all += "未知命令，输入 help 查看帮助\n";
        r["ok"] = true;
        r["output"] = all;
        code = 200;
      }
    } catch (const std::exception& e) { r["error"] = "bad request"; code = 400; }
    catch (...) { r["error"] = "bad request"; code = 400; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }

  // ---- 调试接口（EW_DEBUG=1）----
  if (path == "/api/debug/teleport" && req.method == "POST" && getenv("EW_DEBUG")) {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      Entity* p = username.empty() ? nullptr : world_.findPlayerByUsername(username);
      if (p) {
        double x = in.at("x").asNumber();
        double z = in.at("z").asNumber();
        p->pos.x = x;
        p->pos.z = z;
        p->pos.y = terrainHeight(x, z) + p->radius + 0.3;
        p->vel = {0, 0, 0};
        p->grounded = true;
        // 防作弊重置：传送属调试工具，避免在途旧输入（传送前已发出）被轨迹校验
        // 误判累积违规踢出。回到 grace 期（acceptedInputs=0），未采样前不校验轨迹。
        ac_.reset(*p);
        p->violations = 0;
        p->acceptedInputs = 0;
        p->rateDrops = 0;
        // 推送 SELF 校正：客户端预测器同步到新位置（防作弊随后校验基于新位置）
        int wfd = fdOfPlayer(p->id);
        if (wfd >= 0) {
          auto it = conns_.find(wfd);
          if (it != conns_.end() && it->second.phase == Conn::Ws) {
            sendTo(it->second, netcode_.correctionFrame(*p, "debug_teleport", (uint32_t)world_.tickCount()));
            netcode_.requestResync(p->id);
          }
        }
        r["ok"] = true;
        r["x"] = p->pos.x; r["y"] = p->pos.y; r["z"] = p->pos.z;
        code = 200;
      } else { r["error"] = "no player"; code = 404; }
    } catch (...) { r["error"] = "bad request"; code = 400; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/debug/bosses" && req.method == "GET" && getenv("EW_DEBUG")) {
    Json arr = Json::array();
    for (const Entity* b : world_.bosses()) {
      Json j = Json::object();
      j["id"] = b->id; j["wid"] = (int64_t)b->wid; j["name"] = b->name;
      j["x"] = b->pos.x; j["y"] = b->pos.y; j["z"] = b->pos.z;
      j["hp"] = b->hp; j["maxHp"] = b->maxHp;
      j["state"] = (int64_t)b->bossState;
      j["phase"] = (int64_t)b->bossPhase;
      j["target"] = (int64_t)b->bossTarget;
      arr.push_back(j);
    }
    Json r = Json::object(); r["bosses"] = arr;
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // 地形高度场数据接口：按区块坐标返回存储的高度场网格（世界地图数据存储层）
  if (path == "/api/terrain/chunk" && req.method == "GET") {
    int64_t cx = 0, cz = 0;
    try { cx = std::stoll(urlDecode(queryParam(req.query, "x"))); } catch (...) {}
    try { cz = std::stoll(urlDecode(queryParam(req.query, "z"))); } catch (...) {}
    const ChunkTerrainData* d = world_.chunks().getTerrainData(cx, cz);
    if (!d) {
      enqueue(c, httpBuildResponse(404, "Not Found", "application/json", "{\"error\":\"chunk\"}"));
      c.closeAfterFlush = true;
      return;
    }
    Json arr = Json::array();
    for (size_t i = 0; i < d->heights.size(); i++) arr.push_back((double)d->heights[i]);
    Json r = Json::object();
    r["cx"] = d->cx; r["cz"] = d->cz;
    r["grid"] = d->grid;
    r["step"] = d->step;
    r["waterLevel"] = kWaterLevel;
    r["heights"] = arr;
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
        if (opcode == WS_BINARY) handleBinary(c, payload);
        else handleBinary(c, payload); // 文本同样按二进制帧解析（兼容/容错）
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
          handleBinary(c, msg);
        }
      }
      return;
    default:
      return;
  }
}

void GameServer::handleBinary(Conn& c, const std::string& payload) {
  size_t off = 0;
  proto::Frame f;
  while (true) {
    size_t consumed = 0;
    if (!proto::parseFrame(payload, off, consumed, f)) break;
    off = consumed;
    switch (f.type) {
      case proto::C2S_INPUT: {
        proto::InputMsg in;
        if (proto::decodeInput(f.payload, in)) handleInput(c, in);
        break;
      }
      case proto::C2S_PONG:
        return; // 心跳应答（TCP 已可靠，暂不统计）
      case proto::C2S_EVENT:
        return; // 预留：通用事件
      case proto::C2S_ATTACK: {
        proto::AttackMsg atk;
        if (proto::decodeAttack(f.payload, atk)) {
          bool hit = world_.playerAttack(c.playerId, atk.targetWid, atk.slot);
          if (getenv("EW_DEBUG"))
            fprintf(stderr, "[ATK] %s -> wid=%u hit=%d\n", c.playerId.c_str(), atk.targetWid, (int)hit);
        }
        break;
      }
      case proto::C2S_SHOP_OPEN: {
        proto::ShopOpenMsg m;
        if (proto::decodeShopOpen(f.payload, m) && world_.openShop(c.playerId, m.npcWid)) {
          Entity* p = world_.findEntity(c.playerId);
          if (p && p->pl.openShopId) {
            const ShopDef* shop = world_.data().shop(p->pl.openShopId);
            if (shop) sendTo(c, proto::shopFrame(*shop));
          }
        }
        break;
      }
      case proto::C2S_SHOP_BUY: {
        proto::ShopBuyMsg m;
        if (proto::decodeShopBuy(f.payload, m) && world_.buyItem(c.playerId, m.itemId, m.count)) {
          Entity* p = world_.findEntity(c.playerId);
          if (p) {
            sendTo(c, proto::inventoryFrame(*p));   // 金币/背包更新
            sendTo(c, proto::statsFrame(*p));       // 属性（无变化也刷一次，简单一致）
          }
        }
        break;
      }
      case proto::C2S_PICKUP: {
        proto::PickupMsg m;
        if (proto::decodePickup(f.payload, m) && world_.playerPickup(c.playerId, m.dropWid)) {
          Entity* p = world_.findEntity(c.playerId);
          if (p) {
            Entity* drop = world_.findByWid(m.dropWid); // 已被拾取销毁，drop=null
            (void)drop;
            sendTo(c, proto::lootFrame(true, 0, 0, 0));
            sendTo(c, proto::inventoryFrame(*p));
          }
        }
        break;
      }
      case proto::C2S_EQUIP: {
        proto::EquipMsg m;
        if (proto::decodeEquip(f.payload, m) && world_.equipItem(c.playerId, m.slot, m.itemId)) {
          Entity* p = world_.findEntity(c.playerId);
          if (p) {
            sendTo(c, proto::inventoryFrame(*p));
            sendTo(c, proto::statsFrame(*p));
          }
        }
        break;
      }
      case proto::C2S_USE_ITEM: {
        proto::UseItemMsg m;
        if (proto::decodeUseItem(f.payload, m) && world_.useItem(c.playerId, m.itemId, m.count)) {
          Entity* p = world_.findEntity(c.playerId);
          if (p) {
            sendTo(c, proto::inventoryFrame(*p));
            sendTo(c, proto::statsFrame(*p));
          }
        }
        break;
      }
      case proto::C2S_CAST_SKILL: {
        proto::CastSkillMsg m;
        if (proto::decodeCastSkill(f.payload, m)) {
          // 服务端权威施放（校验已学/冷却/耗蓝/目标/距离 + 前摇/施放时间判定）
          bool ok = world_.beginCast(c.playerId, m.skillId, m.targetWid, m.tx, m.tz);
          const SkillDef* sd = world_.data().skill(m.skillId);
          uint16_t ctm = sd ? (uint16_t)sd->castTimeMs : 0;
          sendTo(c, proto::skillCastFrame(ok, m.skillId, m.targetWid,
                                          proto::qAbs(m.tx), proto::qAbs(m.tz), ctm));
        }
        break;
      }
      case proto::C2S_CONSOLE: {
        std::string cmd;
        proto::Reader r(f.payload);
        if (r.str(cmd)) handleConsoleLine(c.playerId, cmd);
        break;
      }
      default:
        return;
    }
  }
}
void GameServer::handleInput(Conn& c, const proto::InputMsg& in) {
  Entity* p = world_.findEntity(c.playerId);
  if (!p) return;
  // 构造防作弊所需的输入描述（复用现有 AntiCheat 校验逻辑）
  Json j = Json::object();
  j["type"] = "input";
  j["seq"] = (int64_t)in.seq;
  j["moveX"] = in.moveX;
  j["moveZ"] = in.moveZ;
  j["jump"] = in.jump;
  j["px"] = in.px;
  j["py"] = in.py;
  j["pz"] = in.pz;
  AntiCheatResult res = ac_.process(*p, j, steadyMs());
  if (res.kick) {
    sendTo(c, proto::kick(res.reason));
    enqueue(c, wsEncodeFrame(WS_CLOSE, ""));
    c.closeAfterFlush = true;
    return;
  }
  if (res.correction) {
    // 服务端后校验不通过 → 回退：拉回服务端权威位置 + 强制校准快照重锚定
    sendTo(c, netcode_.correctionFrame(*p, res.reason, (uint32_t)world_.tickCount()));
    netcode_.requestResync(p->id);
  }
  if (getenv("EW_DEBUG")) {
    fprintf(stderr, "[AC] %s reason=%s %s\n", p->id.c_str(), res.reason.c_str(),
            res.accepted ? "accepted" : "rejected");
  }
}
// 游戏控制台：执行一行命令并把逐行结果发给目标玩家（WS/HTTP 通道）
void GameServer::handleConsoleLine(const std::string& playerId, const std::string& line) {
  ConsoleCtx ctx;
  ctx.world = &world_;
  ctx.playerId = playerId;
  std::vector<std::string> lines;
  ctx.out = [&](const std::string& s) { lines.push_back(s); };
  bool known = consoleExecute(ctx, line);
  if (!known) lines.push_back("未知命令，输入 help 查看帮助");
  // 汇总逐行结果（UTF-8）→ 一条 S2C_CONSOLE 帧
  std::string all;
  for (auto& s : lines) { all += s; all += "\n"; }
  int fd = fdOfPlayer(playerId);
  if (fd >= 0) {
    auto it = conns_.find(fd);
    if (it != conns_.end()) sendTo(it->second, proto::consoleFrame(all));
  } else if (!playerId.empty()) {
    fprintf(stderr, "[console] %s -> %s\n", playerId.c_str(), all.c_str());
  }
}
// 游戏控制台（stdin 通道）：读一行执行，结果打印到 stderr（不干扰 HTTP/WS 输出）
void GameServer::handleStdinConsole() {
  char buf[1024];
  ssize_t n;
  while ((n = read(STDIN_FILENO, buf, sizeof(buf) - 1)) > 0) {
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n' || buf[i] == '\r') {
        if (!stdinLine_.empty()) {
          ConsoleCtx ctx;
          ctx.world = &world_;
          ctx.out = [](const std::string& s) { fprintf(stderr, "[console] %s\n", s.c_str()); };
          bool known = consoleExecute(ctx, stdinLine_);
          if (!known) fprintf(stderr, "[console] 未知命令：%s（help 查看帮助）\n", stdinLine_.c_str());
          stdinLine_.clear();
        }
      } else {
        stdinLine_.push_back(buf[i]);
      }
    }
  }
}
void GameServer::sendTo(Conn& c, const std::string& frame) {
  enqueue(c, wsEncodeFrame(WS_BINARY, frame));
}
int GameServer::fdOfPlayer(const std::string& playerId) const {
  for (const auto& [fd, c] : conns_) {
    if (c.playerId == playerId) return fd;
  }
  return -1;
}
// 每 tick：为每个在线玩家构建并下发二进制缓冲（AOI 进出 + 增量 + 校准快照）
// 物品系统持久化：装备槽 -> JSON {"helm":1001,...}
static std::string serializeEquip(const std::array<uint32_t, 6>& equip) {
  Json o = Json::object();
  for (int i = 0; i < (int)equip.size(); i++) {
    if (!equip[i]) continue;
    o[GameData::slotKey(ew::GameData::indexSlot(i))] = (int64_t)equip[i];
  }
  return o.dump();
}
// 背包 itemId->数量 -> JSON {"2001":5,...}
static std::string serializeInventory(const std::unordered_map<uint32_t, uint32_t>& inv) {
  Json o = Json::object();
  for (const auto& [id, cnt] : inv) o[std::to_string(id)] = (int64_t)cnt;
  return o.dump();
}
// 从存档 JSON 恢复玩家背包/装备
void applySaveItems(World& w, Entity& p, const PlayerSave& ps) {
  try {
    if (!ps.equipJson.empty()) {
      Json eq = Json::parse(ps.equipJson);
      if (eq.type() == Json::Type::Object) {
        for (auto& [key, v] : eq.asObject()) {
          int idx;
          EquipSlot slot = GameData::slotFromJson(Json(key), EquipSlot::WEAPON);
          if (GameData::slotIndex(slot, idx)) p.pl.equip[idx] = (uint32_t)v.asInt();
        }
      }
    }
    if (!ps.inventoryJson.empty()) {
      Json inv = Json::parse(ps.inventoryJson);
      if (inv.type() == Json::Type::Object) {
        for (auto& [idStr, cnt] : inv.asObject()) {
          uint32_t id = (uint32_t)atoi(idStr.c_str());
          uint32_t n = (uint32_t)cnt.asInt();
          if (id && n) p.pl.inventory[id] = n;
        }
      }
    }
  } catch (const std::exception& e) {
    fprintf(stderr, "[save] 恢复背包失败: %s\n", e.what());
  }
  (void)w;
}

void GameServer::savePlayerToStore(const Entity& e) {
  PlayerSave ps;
  ps.username = e.username;
  ps.x = (float)e.pos.x; ps.y = (float)e.pos.y; ps.z = (float)e.pos.z;
  ps.hp = (float)e.hp;
  ps.level = e.level;
  ps.gold = e.pl.gold;
  ps.equipJson = serializeEquip(e.pl.equip);
  ps.inventoryJson = serializeInventory(e.pl.inventory);
  ps.updatedAtMs = world_.tickCount() * (uint64_t)cfg_.tickMs;
  store_.savePlayer(ps);
}
void GameServer::periodicSavePlayers() {
  for (const auto& pid : world_.players()) {
    Entity* e = world_.findEntity(pid);
    if (e && e->kind == EntityKind::Player) savePlayerToStore(*e);
  }
}
void GameServer::broadcastTick() {
  const auto& out = netcode_.tickBroadcast();
  for (const auto& [pid, buf] : out) {
    int fd = fdOfPlayer(pid);
    if (fd < 0) continue;
    auto it = conns_.find(fd);
    if (it == conns_.end() || it->second.phase != Conn::Ws) continue;
    enqueue(it->second, wsEncodeFrame(WS_BINARY, buf));
  }
  if (getenv("EW_NETDBG")) {
    static uint64_t lastLog = 0;
    static uint64_t accBytes = 0, accFrames = 0, accTicks = 0;
    uint64_t now = steadyMs();
    for (const auto& [pid, buf] : out) { (void)pid; accBytes += buf.size(); accFrames++; }
    accTicks++;
    if (lastLog == 0) lastLog = now;
    if (now - lastLog >= 2000) {
      double s = (double)(now - lastLog) / 1000.0;
      fprintf(stderr, "[NET] down=%.1f KB/s frames=%llu ticks=%llu conns=%zu\n",
              (double)accBytes / 1024.0 / s,
              (unsigned long long)accFrames, (unsigned long long)accTicks, conns_.size());
      lastLog = now; accBytes = 0; accFrames = 0; accTicks = 0;
    }
  }
}
} // namespace ew
