// server.cpp - epoll 事件循环实现（单线程：HTTP + WebSocket(二进制) + 游戏 tick）
#include "server.h"
#include "websocket.h"
#include "http.h"
#include "net/protocol.h"
#include "game/console.h"
#include "game/terrain.h"
#include "util/base64.h"
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
          // 死亡状态存档（hp<=0）：忽略旧位置，回主城复活
          if (ps.hp <= 0) {
            hasSave = false;
            fprintf(stderr, "[save] %s 存档为死亡状态(hp=%.0f)，回主城复活\n",
                    username.c_str(), ps.hp);
          } else {
            hint = {ps.x, ps.y, ps.z};
            hasSave = true;
          }
        }
        Entity* player = world_.spawnPlayer(username, hasSave ? &hint : nullptr);
        if (hasSave) {
          player->hp = ps.hp > 0 && ps.hp <= player->maxHp ? ps.hp : player->maxHp;
          player->level = ps.level;
          player->pl.exp = ps.exp;
          player->pl.gold = ps.gold;
          applySaveItems(world_, *player, ps); // 恢复背包/装备（JSON）
          world_.recomputeStats(*player);
          // 恢复任务数据
          if (!ps.questsJson.empty()) {
            world_.quests().deserializeQuests(*player, ps.questsJson);
          } else {
            // 尝试从独立任务存储加载
            std::string qj = store_.loadQuests(username);
            if (!qj.empty()) world_.quests().deserializeQuests(*player, qj);
          }
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
        // 任务系统：登录即下发活跃任务进度
        enqueue(c, wsEncodeFrame(WS_BINARY, world_.quests().questProgressFrame(*player)));
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
  // GET /api/me?token=xxx -> {ok, username} 或 401 {ok:false, error:"auth"}
  // 只读校验令牌（无任何副作用）：供客户端刷新页面时判断已保存的会话是否仍有效，
  // 避免编辑器/游戏拿着失效令牌进入界面后才在写请求上失败。
  if (path == "/api/me" && req.method == "GET") {
    Json r = Json::object();
    int code = 401;
    std::string username = auth_.verifyToken(urlDecode(queryParam(req.query, "token")));
    if (username.empty()) { r["ok"] = false; r["error"] = "auth"; }
    else { r["ok"] = true; r["username"] = username; code = 200; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Unauthorized", "application/json", r.dump()));
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
        p->pos.y = groundFootY(x, z, p->radius);
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
  // 调试：注入存档 JSON 并执行 applySaveItems（P8-d 旧档→装备实例迁移测试用；EW_DEBUG 限定）
  // 清空当前物品后按传入 equipJson/inventoryJson/warehouseJson 重新加载，复现“登录读档”路径。
  if (path == "/api/debug/loadlegacy" && req.method == "POST" && getenv("EW_DEBUG")) {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      Entity* p = username.empty() ? nullptr : world_.findPlayerByUsername(username);
      if (p) {
        for (auto& ins : p->pl.equip) ins = ItemInstance{};   // 清空已穿戴
        p->pl.equipBag.clear();                               // 清空背包装备实例
        p->pl.inventory.clear();                              // 清空堆叠背包
        PlayerSave ps;
        ps.username = p->username;
        ps.equipJson = in.has("equipJson") ? in.at("equipJson").asString() : "";
        ps.inventoryJson = in.has("inventoryJson") ? in.at("inventoryJson").asString() : "";
        ps.warehouseJson = in.has("warehouseJson") ? in.at("warehouseJson").asString() : "";
        applySaveItems(world_, *p, ps);   // 旧档迁移：无实例→自动分配 instId 转实例
        world_.markInvDirty(p->id);
        world_.markStatsDirty(p->id);
        r["ok"] = true;
        r["equipBag"] = (int64_t)p->pl.equipBag.size();
        r["inventory"] = (int64_t)p->pl.inventory.size();
        code = 200;
      } else { r["error"] = "no player"; code = 404; }
    } catch (...) { r["error"] = "bad request"; code = 400; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/debug/elites" && req.method == "GET" && getenv("EW_DEBUG")) {
    Json arr = Json::array();
    for (const Entity* b : world_.elites()) {
      Json j = Json::object();
      j["id"] = b->id; j["wid"] = (int64_t)b->wid; j["name"] = b->name;
      j["x"] = b->pos.x; j["y"] = b->pos.y; j["z"] = b->pos.z;
      j["hp"] = b->hp; j["maxHp"] = b->maxHp;
      j["state"] = (int64_t)b->eliteState;
      j["phase"] = (int64_t)b->elitePhase;
      j["target"] = (int64_t)b->eliteTarget;
      arr.push_back(j);
    }
    Json r = Json::object(); r["elites"] = arr;
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

  // ---- 地形编辑器编辑层接口（编辑器：读取/保存） ----
  // GET: 返回当前编辑层 {ok, count, cells: {"x,z": {h?,v?}}}（公开读取，与客户端 terrain.js 一致）
  // 生物出生点配置：GET 读取当前出生点列表（剧本编辑器用）
  if (path == "/api/spawns" && req.method == "GET") {
    Json r = Json::object();
    r["ok"] = true;
    r["count"] = (int64_t)world_.spawns().size();
    Json root = Json::parse(world_.spawns().toJson());
    r["spawns"] = root["spawns"];
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存出生点 {token, spawns:[...]} -> 校验后应用 + 持久化 data/spawns.json + 热重载世界生物
  if (path == "/api/spawns/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("spawns") || in.at("spawns").type() != Json::Type::Array) {
        r["error"] = "spawns array required";
      } else {
        Json root = Json::object(); root["spawns"] = in.at("spawns");
        if (world_.applySpawns(root.dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.spawns().size();
          code = 200;
        } else { r["error"] = "bad spawns"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // ---- 可通行 mask 下发（数据驱动：客户端不再程序化生成，与服务端同源）----
  // GET /api/terrain/mask -> {ok,n,off,b64}；b64 为 n*n 字节 mask（1=可通行）的 base64
  if (path == "/api/terrain/mask" && req.method == "GET") {
    Json r = Json::object();
    if (terrainWalkMaskReady()) {
      const std::vector<uint8_t>& m = terrainWalkMask();
      r["ok"] = true;
      r["n"] = (int64_t)terrainWalkMaskN();
      r["off"] = (int64_t)terrainWalkMaskOff();
      r["b64"] = base64Encode(m.data(), m.size());
      r["seedOffset"] = (int64_t)world_.seed();
    } else {
      r["ok"] = false;
    }
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // ---- 重新执行世界初始化（世界编辑器）----
  // POST /api/world/reinit {token} -> 重新生成连通地形+主城+分组生物投放；
  //   数据库模式同步落库；热重载世界生物；返回新 mask + 出生点供编辑器刷新。
  if (path == "/api/world/reinit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else {
        // 生成新种子，确保每次 reinit 产生不同的地形/mask/出生点
        uint32_t newSeed = (uint32_t)std::chrono::system_clock::now().time_since_epoch().count();
        world_.setSeed(newSeed);
        fprintf(stderr, "[reinit] 新世界种子: %u\n", newSeed);
        if (world_.runWorldInit()) {
        if (store_.worldDataPersistent()) world_.saveWorldToStore(store_);
        world_.reseedCreatures();   // 清空旧生物并按新出生点重建
        // 通知所有在线客户端重拉地形：mask 已整张重建。不同步会让客户端的
        // terrainBlockedExact 与服务端分歧 → 上报被判 terrain_blocked → 橡皮筋/反复校正。
        broadcastWorld(proto::terrainDirtyFrame());
        const std::vector<uint8_t>& m = terrainWalkMask();
        r["ok"] = true;
        r["n"] = (int64_t)terrainWalkMaskN();
        r["off"] = (int64_t)terrainWalkMaskOff();
        r["b64"] = base64Encode(m.data(), m.size());
        r["seedOffset"] = (int64_t)world_.seed();
        r["count"] = (int64_t)world_.spawns().size();
        r["spawns"] = Json::parse(world_.spawns().toJson())["spawns"];
        code = 200;
      } else { r["error"] = "worldinit failed"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  if (path == "/api/terrain/edit" && req.method == "GET") {
    Json r = Json::object();
    r["ok"] = true;
    r["count"] = (int64_t)terrainEditSize();
    Json cells = Json::object();
    for (const auto& [k, c] : terrainEdits()) {
      int64_t x = (int32_t)(k >> 32);
      int64_t z = (int32_t)(k & 0xFFFFFFFFLL);
      char key[64];
      snprintf(key, sizeof(key), "%lld,%lld", (long long)x, (long long)z);
      Json j = Json::object();
      if (c.hasH) j["h"] = c.h;
      if (c.hasV) j["v"] = (int64_t)c.v;
      cells[key] = j;
    }
    r["cells"] = cells;
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存编辑层 {token, cells} -> 校验后应用内存 + 数据库模式落库
  if (path == "/api/terrain/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("cells") || in.at("cells").type() != Json::Type::Object) {
        r["error"] = "cells object required";
      } else {
        Json root = Json::object(); root["cells"] = in.at("cells");
        if (terrainEditFromJson(root.dump())) {
          // 数据库模式同步落库（内存模式重启即重置）
          if (store_.worldDataPersistent()) store_.saveWorldData("terrain_edit", terrainEditToJson());
          // 通知在线客户端重拉编辑层：否则客户端仍用旧的可通行/高度覆盖，在新挖空的
          // 格子上继续放行上报 → 服务端拒绝 → 玩家卡在坑里反复校正。
          broadcastWorld(proto::terrainDirtyFrame());
          r["ok"] = true;
          r["count"] = (int64_t)terrainEditSize();
          code = 200;
        } else { r["error"] = "bad edit"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }

  // ---- 游戏数据接口（物品/生物配置：客户端动态加载 + 编辑器读写） ----
  // GET: 返回完整物品表与生物表（公开只读，游戏客户端启动时拉取，替换静态镜像）
  if (path == "/api/gamedata" && req.method == "GET") {
    Json r = Json::object();
    r["ok"] = true;
    try {
      r["items"] = Json::parse(world_.data().itemsToJson());
      r["monsters"] = Json::parse(world_.data().monstersToJson());
      r["npcs"] = Json::parse(world_.npcs().npcsToJson());
      r["enhance"] = Json::parse(world_.economy().enhance().configToJson());  // 强化配置（15 级表 + 系数）
      r["decompose"] = Json::parse(world_.economy().enhance().decomposeConfigToJson());  // 分解配置（5 档品质规则）
      r["craft"] = Json::parse(world_.economy().craft().configToJson());  // 合成配方表（材料/产出/等级/隐藏）
      r["warehouse"] = Json::parse(world_.warehouse().configToJson());  // 仓库配置（页数/格子/扩展费用/存金上限）
      r["shops"] = Json::parse(world_.data().shopsToJson());  // 商店配置（阶段7编辑器：分类/限购/折扣/回收）
      r["skills"] = Json::parse(world_.data().skillsToJson());  // 技能配置（世界编辑器技能编辑模式）
    } catch (...) {
      r["items"] = Json::array();
      r["monsters"] = Json::object();
      r["npcs"] = Json::object();
      r["enhance"] = Json::object();
      r["decompose"] = Json::object();
      r["craft"] = Json::object();
      r["warehouse"] = Json::object();
      r["shops"] = Json::object();
      r["skills"] = Json::object();
    }
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存物品配置 {token, items:[...]} -> 热替换内存 + 数据库模式落库
  if (path == "/api/items/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("items") || in.at("items").type() != Json::Type::Array) {
        r["error"] = "items array required";
      } else {
        if (world_.applyItems(in.at("items").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.data().items().size();
          code = 200;
        } else { r["error"] = "bad items"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存生物配置 {token, monsters:{...}} -> 热替换内存 + 数据库模式落库 + 热重载世界生物
  if (path == "/api/monsters/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("monsters") || in.at("monsters").type() != Json::Type::Object) {
        r["error"] = "monsters object required";
      } else {
        if (world_.applyMonsters(in.at("monsters").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.data().monsters().size();
          code = 200;
        } else { r["error"] = "bad monsters"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存 NPC 配置 {token, npcs:{...}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/npcs/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("npcs") || in.at("npcs").type() != Json::Type::Object) {
        r["error"] = "npcs object required";
      } else {
        if (world_.applyNpcs(in.at("npcs").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.npcs().npcs().size();
          code = 200;
        } else { r["error"] = "bad npcs"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // ---- 任务配置接口（编辑器：读取/保存） ----
  // GET: 返回当前任务列表 {ok, count, quests: [...]}
  if (path == "/api/quests" && req.method == "GET") {
    Json r = Json::object();
    r["ok"] = true;
    try {
      r["quests"] = Json::parse(world_.quests().questsToJson());
      r["count"] = (int64_t)world_.quests().quests().size();
    } catch (...) {
      r["quests"] = Json::array();
      r["count"] = 0;
    }
    enqueue(c, httpBuildResponse(200, "OK", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存任务配置 {token, quests:[...]} -> 热替换 + 持久化 data/quests.json
  if (path == "/api/quests/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("quests") || in.at("quests").type() != Json::Type::Array) {
        r["error"] = "quests array required";
      } else {
        if (world_.quests().replaceQuests(in.at("quests"))) {
          // 持久化到 data/quests.json
          std::string questsJson = in.at("quests").dump();
          std::string questsPath = cfg_.dataDir + "/quests.json";
          FILE* fp = fopen(questsPath.c_str(), "wb");
          if (fp) { fwrite(questsJson.data(), 1, questsJson.size(), fp); fclose(fp); }
          r["ok"] = true;
          r["count"] = (int64_t)world_.quests().quests().size();
          code = 200;
        } else { r["error"] = "bad quests"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }

  // ---- 经济配置接口（阶段7编辑器：强化/分解/合成/商店 热重载）----
  // POST: 保存强化配置 {token, enhance:{...}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/enhance/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("enhance") || in.at("enhance").type() != Json::Type::Object) {
        r["error"] = "enhance object required";
      } else {
        if (world_.applyEnhance(in.at("enhance").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.economy().enhance().config().levels.size();
          code = 200;
        } else { r["error"] = "bad enhance"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存分解配置 {token, decompose:{...}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/decompose/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("decompose") || in.at("decompose").type() != Json::Type::Object) {
        r["error"] = "decompose object required";
      } else {
        if (world_.applyDecompose(in.at("decompose").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.economy().enhance().decomposeConfig().rules.size();
          code = 200;
        } else { r["error"] = "bad decompose"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存合成配方 {token, craft:{recipes:[...]}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/craft/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("craft") || in.at("craft").type() != Json::Type::Object) {
        r["error"] = "craft object required";
      } else {
        if (world_.applyCraft(in.at("craft").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.economy().craft().recipes().size();
          code = 200;
        } else { r["error"] = "bad craft"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存商店配置 {token, shops:{...}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/shop/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("shops") || in.at("shops").type() != Json::Type::Object) {
        r["error"] = "shops object required";
      } else {
        if (world_.applyShop(in.at("shops").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.data().shops().size();
          code = 200;
        } else { r["error"] = "bad shops"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
    c.closeAfterFlush = true;
    return;
  }
  // POST: 保存技能配置 {token, skills:{starterSkills:[], skills:[...]}} -> 热替换内存 + 数据库模式落库
  if (path == "/api/skills/edit" && req.method == "POST") {
    Json r = Json::object(); r["ok"] = false;
    int code = 400;
    try {
      Json in = Json::parse(req.body);
      std::string username = auth_.verifyToken(in.at("token").asString());
      if (username.empty()) { r["error"] = "auth"; code = 401; }
      else if (!in.has("skills") || in.at("skills").type() != Json::Type::Object) {
        r["error"] = "skills object required";
      } else {
        if (world_.applySkills(in.at("skills").dump(), cfg_.dataDir)) {
          r["ok"] = true;
          r["count"] = (int64_t)world_.data().skills().size();
          code = 200;
        } else { r["error"] = "bad skills"; }
      }
    } catch (...) { r["error"] = "bad request"; }
    enqueue(c, httpBuildResponse(code, code == 200 ? "OK" : "Error", "application/json", r.dump()));
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
            if (shop) sendTo(c, proto::shopFrame(*shop, p));  // 附带限购已购进度
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
            // 限购进度刷新：重发 shopFrame（含 bought 计数），客户端据此更新“已购 X/限购 Y”
            if (p->pl.openShopId) {
              const ShopDef* shop = world_.data().shop(p->pl.openShopId);
              if (shop) sendTo(c, proto::shopFrame(*shop, p));
            }
          }
        }
        break;
      }
      case proto::C2S_SHOP_SELL: {
        proto::ShopSellMsg m;
        if (proto::decodeShopSell(f.payload, m)) {
          uint32_t gain = world_.sellItem(c.playerId, m.isInstance, m.instId, m.itemId, m.count);
          sendTo(c, proto::sellResultFrame(gain > 0, gain));
          if (gain > 0) {
            Entity* p = world_.findEntity(c.playerId);
            if (p) sendTo(c, proto::inventoryFrame(*p)); // 金币/背包更新（出售背包装备不影响已穿戴属性）
          }
        }
        break;
      }
      case proto::C2S_ENHANCE: {
        proto::EnhanceMsg m;
        if (proto::decodeEnhance(f.payload, m)) {
          // 强化：铁匠邻近 + 金币/强化石/保护符校验均在 enhanceEquip 内完成（服务端权威）
          EnhanceResult r = world_.enhanceEquip(c.playerId, m.instId, m.useProtect);
          sendTo(c, proto::enhanceFrame(r.ok, (uint8_t)r.failCode, m.instId,
                                        (uint8_t)r.newLevel, r.success, r.goldLeft));
          // 成功/降级后的背包与属性由 enhanceEquip 标记脏，netcode 每 tick 补发 S2C_INVENTORY/S2C_STATS
        }
        break;
      }
      case proto::C2S_DECOMPOSE: {
        proto::DecomposeMsg m;
        if (proto::decodeDecompose(f.payload, m)) {
          // 分解：铁匠邻近 + 已穿戴/锁定校验均在 decomposeEquip 内完成（服务端权威）
          DecomposeOutput o = world_.decomposeEquip(c.playerId, m.instId);
          sendTo(c, proto::decomposeFrame(o.ok, (uint8_t)o.failCode, o.items, o.goldGain));
          // 成功后背包由 decomposeEquip 标记脏，netcode 每 tick 补发 S2C_INVENTORY
        }
        break;
      }
      case proto::C2S_CRAFT_LIST: {
        proto::CraftListMsg m;
        if (proto::decodeCraftList(f.payload, m)) {
          // 按 NPC 标签 + 玩家等级过滤可用配方（隐藏/等级不足不返回；服务端权威）
          std::vector<uint32_t> ids = world_.craftList(c.playerId, m.npcWid);
          sendTo(c, proto::craftListFrame(ids));
        }
        break;
      }
      case proto::C2S_CRAFT: {
        proto::CraftMsg m;
        if (proto::decodeCraft(f.payload, m)) {
          // 合成：合成 NPC 邻近 + 等级/材料/金币校验均在 craftItem 内完成（服务端权威）
          CraftOutput o = world_.craftItem(c.playerId, m.recipeId, m.count);
          sendTo(c, proto::craftFrame(o.ok, (uint8_t)o.failCode, o.recipeId, o.resultItemId,
                                      (uint16_t)o.resultCount, o.isInstance, o.instId));
          // 成功后背包由 craftItem 标记脏，netcode 每 tick 补发 S2C_INVENTORY
        }
        break;
      }
      case proto::C2S_WAREHOUSE_OPEN: {
        proto::WarehouseOpenMsg m;
        if (proto::decodeWarehouseOpen(f.payload, m)) {
          // 打开仓库：银行 NPC 邻近 + BANK 标签校验在 openWarehouse 内（服务端权威）
          const WarehouseData* wh = world_.openWarehouse(c.playerId, m.npcWid);
          if (wh) sendTo(c, proto::warehouseFrame(*wh));
          else sendTo(c, proto::warehouseResultFrame(WH_OP_OPEN, WH_NO_NPC));
        }
        break;
      }
      case proto::C2S_WAREHOUSE_DEPOSIT: {
        proto::WarehouseMoveMsg m;
        if (proto::decodeWarehouseMove(f.payload, m)) {
          // 存入：银行邻近 + 金币/装备/堆叠处理均在 depositItem 内（服务端权威）
          uint8_t code = world_.depositItem(c.playerId, m.isInstance, m.instId, m.itemId, m.count);
          sendTo(c, proto::warehouseResultFrame(WH_OP_DEPOSIT, code));
          if (code == WH_OK) { const WarehouseData* wh = world_.warehouseData(c.playerId); if (wh) sendTo(c, proto::warehouseFrame(*wh)); }
        }
        break;
      }
      case proto::C2S_WAREHOUSE_WITHDRAW: {
        proto::WarehouseMoveMsg m;
        if (proto::decodeWarehouseMove(f.payload, m)) {
          // 取出：银行邻近 + 装备保留强化/堆叠回背包均在 withdrawItem 内（服务端权威）
          uint8_t code = world_.withdrawItem(c.playerId, m.isInstance, m.instId, m.itemId, m.count);
          sendTo(c, proto::warehouseResultFrame(WH_OP_WITHDRAW, code));
          if (code == WH_OK) { const WarehouseData* wh = world_.warehouseData(c.playerId); if (wh) sendTo(c, proto::warehouseFrame(*wh)); }
        }
        break;
      }
      case proto::C2S_WAREHOUSE_EXPAND: {
        // 扩展：银行邻近 + 扣金币(1000×1.5^n)/满150拒绝均在 expandWarehouse 内（服务端权威）
        uint8_t code = world_.expandWarehouse(c.playerId);
        sendTo(c, proto::warehouseResultFrame(WH_OP_EXPAND, code));
        if (code == WH_OK) { const WarehouseData* wh = world_.warehouseData(c.playerId); if (wh) sendTo(c, proto::warehouseFrame(*wh)); }
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
        if (proto::decodeEquip(f.payload, m) && world_.equipItem(c.playerId, m.slot, m.instId)) {
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
          // 服务端权威施放（校验已学/眩晕/冷却/耗蓝/施法距离 + 前摇/施放时间判定）
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
      // ---- 社交系统：好友 ----
      case proto::C2S_FRIEND_ADD: {
        proto::FriendAddMsg m;
        if (proto::decodeFriendAdd(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().sendRequest(p->username, m.targetName, m.message);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_ADD, (uint8_t)result));
          if (result == FRIEND_OK) {
            // 通知目标玩家收到好友请求
            sendToPlayer(m.targetName, proto::friendRequestFrame(p->username, m.message));
          }
        }
        break;
      }
      case proto::C2S_FRIEND_ACCEPT: {
        proto::FriendAcceptMsg m;
        if (proto::decodeFriendAccept(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().acceptRequest(p->username, m.fromUser);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_ACCEPT, (uint8_t)result));
          if (result == FRIEND_OK) {
            // 通知双方好友列表更新
            sendToPlayer(m.fromUser, proto::friendStatusFrame(p->username, true));
            sendTo(c, proto::friendStatusFrame(m.fromUser, true));
          }
        }
        break;
      }
      case proto::C2S_FRIEND_REJECT: {
        proto::FriendRejectMsg m;
        if (proto::decodeFriendReject(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().rejectRequest(p->username, m.fromUser);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_REJECT, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_FRIEND_REMOVE: {
        proto::FriendRemoveMsg m;
        if (proto::decodeFriendRemove(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().removeFriend(p->username, m.targetName);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_REMOVE, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_FRIEND_BLOCK: {
        proto::FriendBlockMsg m;
        if (proto::decodeFriendBlock(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().blockUser(p->username, m.targetName);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_BLOCK, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_FRIEND_UNBLOCK: {
        proto::FriendUnblockMsg m;
        if (proto::decodeFriendUnblock(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.friends().unblockUser(p->username, m.targetName);
          sendTo(c, proto::friendResultFrame(FRIEND_OP_UNBLOCK, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_FRIEND_LIST: {
        Entity* p = world_.findEntity(c.playerId);
        if (!p) break;
        auto list = world_.friends().buildFriendList(p->username);
        sendTo(c, proto::friendListFrame(list));
        break;
      }
      // ---- 社交系统：公会 ----
      case proto::C2S_GUILD_CREATE: {
        proto::GuildCreateMsg m;
        if (proto::decodeGuildCreate(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().createGuild(p->username, m.name);
          sendTo(c, proto::guildResultFrame(0, (uint8_t)result));
          if (result == GUILD_OK) {
            uint32_t gid = world_.guilds().getPlayerGuildId(p->username);
            proto::GuildInfoData info;
            if (world_.guilds().buildGuildInfo(gid, info)) {
              sendTo(c, proto::guildInfoFrame(info));
            }
          }
        }
        break;
      }
      case proto::C2S_GUILD_DISBAND: {
        Entity* p = world_.findEntity(c.playerId);
        if (!p) break;
        auto result = world_.guilds().disbandGuild(p->username);
        sendTo(c, proto::guildResultFrame(1, (uint8_t)result));
        break;
      }
      case proto::C2S_GUILD_APPLY: {
        proto::GuildApplyMsg m;
        if (proto::decodeGuildApply(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().applyToGuild(p->username, m.guildId, "");
          sendTo(c, proto::guildResultFrame(2, (uint8_t)result));
          if (result == GUILD_OK) {
            // 通知公会在线官员
            const Guild* g = world_.guilds().getGuild(m.guildId);
            if (g) {
              std::string notifyFrame = proto::guildApplyNotifyFrame(p->username, m.guildId);
              for (const auto& mem : g->members) {
                if (mem.role <= GUILD_OFFICER && world_.findPlayerByUsername(mem.username)) {
                  sendToPlayer(mem.username, notifyFrame);
                }
              }
            }
          }
        }
        break;
      }
      case proto::C2S_GUILD_APPROVE: {
        proto::GuildApproveMsg m;
        if (proto::decodeGuildApprove(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().approveApplication(p->username, m.applicantName, m.approve != 0);
          sendTo(c, proto::guildResultFrame(3, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_GUILD_KICK: {
        proto::GuildKickMsg m;
        if (proto::decodeGuildKick(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().kickMember(p->username, m.targetName);
          sendTo(c, proto::guildResultFrame(4, (uint8_t)result));
          if (result == GUILD_OK) {
            sendToPlayer(m.targetName, proto::guildNotifyFrame(GUILD_NOTIFY_KICKED, p->username));
          }
        }
        break;
      }
      case proto::C2S_GUILD_PROMOTE: {
        proto::GuildPromoteMsg m;
        if (proto::decodeGuildPromote(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().promoteMember(p->username, m.targetName);
          sendTo(c, proto::guildResultFrame(5, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_GUILD_DEMOTE: {
        proto::GuildDemoteMsg m;
        if (proto::decodeGuildDemote(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().demoteMember(p->username, m.targetName);
          sendTo(c, proto::guildResultFrame(6, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_GUILD_LEAVE: {
        Entity* p = world_.findEntity(c.playerId);
        if (!p) break;
        auto result = world_.guilds().leaveGuild(p->username);
        sendTo(c, proto::guildResultFrame(7, (uint8_t)result));
        break;
      }
      case proto::C2S_GUILD_TRANSFER: {
        proto::GuildTransferMsg m;
        if (proto::decodeGuildTransfer(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().transferLeadership(p->username, m.targetName);
          sendTo(c, proto::guildResultFrame(8, (uint8_t)result));
        }
        break;
      }
      case proto::C2S_GUILD_NOTICE: {
        proto::GuildNoticeMsg m;
        if (proto::decodeGuildNotice(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.guilds().editNotice(p->username, m.notice);
          sendTo(c, proto::guildResultFrame(9, (uint8_t)result));
          if (result == GUILD_OK) {
            uint32_t gid = world_.guilds().getPlayerGuildId(p->username);
            broadcastToGuild(gid, proto::guildNotifyFrame(GUILD_NOTIFY_NOTICE, m.notice));
          }
        }
        break;
      }
      case proto::C2S_GUILD_INFO: {
        Entity* p = world_.findEntity(c.playerId);
        if (!p) break;
        uint32_t gid = world_.guilds().getPlayerGuildId(p->username);
        if (gid == 0) break;
        proto::GuildInfoData info;
        if (world_.guilds().buildGuildInfo(gid, info)) {
          sendTo(c, proto::guildInfoFrame(info));
        }
        break;
      }
      case proto::C2S_GUILD_LIST: {
        proto::GuildListMsg m;
        if (proto::decodeGuildList(f.payload, m)) {
          auto guilds = world_.guilds().searchGuilds(m.keyword);
          std::vector<proto::GuildBriefData> briefs;
          for (const auto& g : guilds) {
            proto::GuildBriefData b;
            b.guildId = g.guildId;
            b.name = g.name;
            b.memberCount = g.memberCount;
            b.level = g.level;
            b.logo = g.logo;
            briefs.push_back(b);
          }
          sendTo(c, proto::guildListFrame(briefs));
        }
        break;
      }
      // ---- 社交系统：聊天 ----
      case proto::C2S_CHAT_SEND: {
        proto::ChatSendMsg m;
        if (proto::decodeChatSend(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          auto result = world_.chat().sendMessage(p->username, (ChatChannel)m.channel, m.target, m.content);
          sendTo(c, proto::chatResultFrame((uint8_t)result.code, ""));
          if (result.code == CHAT_OK || result.code == CHAT_ERR_TARGET_OFFLINE) {
            // 发送给接收者
            std::string chatFrame = proto::chatMsgFrame(
                (uint8_t)result.msg.channel, result.msg.senderName,
                result.msg.senderWid, result.msg.content, result.msg.timestampMs);
            for (const auto& recipient : result.recipients) {
              sendToPlayer(recipient, chatFrame);
            }
          }
        }
        break;
      }
      // ---- 任务系统 ----
      case proto::C2S_QUEST_ACCEPT: {
        proto::QuestAcceptMsg m;
        if (proto::decodeQuestAccept(f.payload, m)) {
          // 查找 NPC 的 npcId（用于 giverNpcId 稳定匹配）
          std::string npcIdStr;
          Entity* acceptNpc = world_.findByWid(m.npcWid);
          if (acceptNpc && acceptNpc->kind == EntityKind::Npc) npcIdStr = acceptNpc->npcId;
          auto result = world_.quests().acceptQuest(c.playerId, m.questId, m.npcWid, npcIdStr);
          sendTo(c, world_.quests().questResultFrame(QUEST_OP_ACCEPT, (uint8_t)result, m.questId));
          if (result == QUEST_OK) {
            sendTo(c, world_.quests().questProgressFrame(*world_.findEntity(c.playerId)));
          }
        }
        break;
      }
      case proto::C2S_QUEST_ABANDON: {
        proto::QuestAbandonMsg m;
        if (proto::decodeQuestAbandon(f.payload, m)) {
          auto result = world_.quests().abandonQuest(c.playerId, m.questId);
          sendTo(c, world_.quests().questResultFrame(QUEST_OP_ABANDON, (uint8_t)result, m.questId));
          if (result == QUEST_OK) {
            Entity* p = world_.findEntity(c.playerId);
            if (p) sendTo(c, world_.quests().questProgressFrame(*p));
          }
        }
        break;
      }
      case proto::C2S_QUEST_TURNIN: {
        proto::QuestTurnInMsg m;
        if (proto::decodeQuestTurnIn(f.payload, m)) {
          // 查找 NPC 的 npcId（用于 talkNpcId 稳定匹配）
          std::string npcIdStr;
          Entity* turnInNpc = world_.findByWid(m.npcWid);
          if (turnInNpc && turnInNpc->kind == EntityKind::Npc) npcIdStr = turnInNpc->npcId;
          auto result = world_.quests().turnInQuest(c.playerId, m.questId, m.npcWid, npcIdStr);
          sendTo(c, world_.quests().questResultFrame(QUEST_OP_TURNIN, (uint8_t)result, m.questId));
          if (result == QUEST_OK) {
            Entity* p = world_.findEntity(c.playerId);
            if (p) {
              sendTo(c, world_.quests().questProgressFrame(*p));
              sendTo(c, proto::inventoryFrame(*p));
              sendTo(c, proto::statsFrame(*p));
              sendTo(c, world_.skillsFrame(*p));
            }
            // 链式任务解锁通知：完成后自动解锁的后续任务
            auto nextIds = world_.quests().getNextQuestIds(m.questId);
            if (!nextIds.empty()) {
              sendTo(c, world_.quests().questChainFrame(m.questId, nextIds));
              // 同时推送更新后的可接任务列表（包含新解锁的任务）
              Entity* p2 = world_.findEntity(c.playerId);
              if (p2) sendTo(c, world_.quests().questListFrame(*p2));
            }
          }
        }
        break;
      }
      case proto::C2S_QUEST_LIST: {
        proto::QuestListMsg m;
        if (proto::decodeQuestList(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          // 查找 NPC 的 npcId（用于 giverNpcId 稳定匹配）
          std::string npcIdStr;
          Entity* listNpc = world_.findByWid(m.npcWid);
          if (listNpc && listNpc->kind == EntityKind::Npc) npcIdStr = listNpc->npcId;
          sendTo(c, world_.quests().questListFrame(*p, m.npcWid, npcIdStr));
        }
        break;
      }
      case proto::C2S_QUEST_TRACK: {
        Entity* p = world_.findEntity(c.playerId);
        if (!p) break;
        sendTo(c, world_.quests().questProgressFrame(*p));
        break;
      }
      case proto::C2S_TALK_NPC: {
        proto::TalkNpcMsg m;
        if (proto::decodeTalkNpc(f.payload, m)) {
          Entity* p = world_.findEntity(c.playerId);
          if (!p) break;
          // 校验 NPC 距离
          Entity* npc = world_.findByWid(m.npcWid);
          if (!npc || npc->kind != EntityKind::Npc) break;
          if (p->pos.dist2D(npc->pos) > cfg_.questTalkRangeM) break;
          // 触发任务目标
          world_.quests().onTalkNpc(*p, m.npcWid);
          // 查找 NPC 定义（用于任务过滤 + 对话文本）
          const NpcDef* def = !npc->npcId.empty() ? world_.npcs().npc(npc->npcId) : nullptr;
          // 返回该 NPC 发布的可接任务 + 全局活跃任务进度（按 npcId 稳定匹配）
          sendTo(c, world_.quests().questListFrame(*p, m.npcWid, npc->npcId));
          sendTo(c, world_.quests().questProgressFrame(*p));
          // 发送 NPC 对话文本（客户端展示配置的对话内容）
          if (def && !def->dialogue.empty()) {
            proto::Writer dw;
            dw.str(def->dialogue);
            sendTo(c, proto::frame(proto::S2C_NPC_DIALOGUE, dw.data()));
          }
        }
        break;
      }
      default:
        return;
    }
  }
}
void GameServer::handleInput(Conn& c, const proto::InputMsg& in) {
  Entity* p = world_.findEntity(c.playerId);
  if (!p || p->dead) return;  // 死亡玩家不处理输入

  uint64_t nowMs = steadyMs();
  ac_.setBypass(world_.testFlags().antiCheatBypass);

  // 必须在 ac_.process() 之前捕获上一次采纳时刻：process() 的成功路径内部会把
  // p.lastAcceptMs 置为 nowMs，事后再读得到的差值恒为 0 → dt=0 → p->vel 恒为 0，
  // 连锁后果：减速限速退化为纯 teleportToleranceM 距离上限、广播给其他玩家的
  // 速度恒为 0、input.targetVX/VZ 恒为 0 使 castSystem 的前摇移动打断彻底失效。
  const uint64_t prevAcceptMs = p->lastAcceptMs;

  // 1. 防作弊：频率/序号/可达性/地形校验
  AntiCheatResult res = ac_.process(*p, (int64_t)in.seq, in.px, in.pz, nowMs);
  if (res.kick) {
    sendTo(c, proto::kick(res.reason));
    enqueue(c, wsEncodeFrame(WS_CLOSE, ""));
    c.closeAfterFlush = true;
    return;
  }
  if (res.correction) {
    // 诊断：打印「被拒的上报位置」与「权威位置」。旧日志只能从客户端看到权威位置，
    // 看不到分歧量，无法定位 terrain_blocked 到底是真穿墙还是双端判定误差。
    if (getenv("EW_DEBUG")) {
      fprintf(stderr, "[AC] %s 拒绝 claim=(%.2f,%.2f) 权威=(%.2f,%.2f) 原因=%s 地形软失败=%d 违规=%d\n",
              p->id.c_str(), in.px, in.pz, p->pos.x, p->pos.z,
              res.reason.c_str(), p->terrainRejects, p->violations);
    }
    sendTo(c, netcode_.correctionFrame(*p, res.reason, (uint32_t)world_.tickCount()));
    netcode_.requestResync(p->id);
    return;
  }
  if (!res.accepted) return;  // rate_limit / stale_seq

  // 地形容差夹紧：严格级失败但收缩半径后通过时，防作弊已把位置沿「权威位置→claim」
  // 线段夹回严格可通行点。必须采纳夹紧后的值，否则权威位置落在阻挡区内 →
  // 后续每次上报都判 terrain_blocked（且客户端被校正到阻挡区后 slideMove 兜底会原地卡死）。
  const double adoptX = res.clamped ? res.x : in.px;
  const double adoptZ = res.clamped ? res.z : in.pz;

  // 2. 控制效果校验：眩晕时拒绝位置变化
  const bool stunned = p->hasBuff((uint8_t)BuffType::STUN);
  if (stunned) {
    // 眩晕下不允许移动，直接采纳服务端当前位置（忽略客户端上报位置）
    // 不发送 correction，因为服务端位置未变
    return;
  }

  // 3. 减速效果：降低可达性上限
  double spdMul = 1.0;
  for (const auto& b : p->buffs) {
    if (b.type == (uint8_t)BuffType::MOVE_SLOW && b.remainSec > 0)
      spdMul -= b.value;
  }
  if (spdMul < 0.05) spdMul = 0.05;
  double effectiveMaxSpeed = cfg_.maxMoveSpeed * spdMul;

  double dt = 0.0;
  if (prevAcceptMs != 0) {
    dt = (double)(nowMs - prevAcceptMs) / 1000.0;
    dt = std::max(0.0, std::min(dt, 1.0));
  } else {
    // 首次输入（prevAcceptMs=0，如刚登录/传送后）：用 1/60s 作为默认 dt，
    // 避免 dt=0 → vel=0 → targetVX/VZ=0 → castSystem 移动打断判据永不成立。
    dt = 1.0 / 60.0;
  }
  double dist = std::hypot(adoptX - p->pos.x, adoptZ - p->pos.z);
  double reach = effectiveMaxSpeed * dt + cfg_.teleportToleranceM;
  if (dist > reach) return;  // 减速下超出可达性，静默丢弃

  // 4. 采纳位置
  Vec3 oldPos = p->pos;
  p->pos.x = adoptX;
  p->pos.z = adoptZ;
  p->pos.y = groundFootY(adoptX, adoptZ, p->radius);
  p->grounded = true;

  // 5. 速度估算（供广播/击退用）
  if (dt > 1e-6) {
    p->vel.x = (adoptX - oldPos.x) / dt;
    p->vel.z = (adoptZ - oldPos.z) / dt;
  } else {
    p->vel.x = 0;
    p->vel.z = 0;
  }
  p->vel.y = 0;

  // 6. 供 castSystem 移动打断用（位置变化 = 移动中）
  p->input.targetVX = p->vel.x;
  p->input.targetVZ = p->vel.z;

  // 7. 任务钩子：移动后检测到达目标
  if (dist > 0.01) {
    world_.quests().onPlayerMove(*p);
  }

  if (getenv("EW_DEBUG")) {
    fprintf(stderr, "[AC] %s pos=(%.1f,%.1f,%.1f) dt=%.4f vel=(%.2f,%.2f) %s%s\n", p->id.c_str(),
            p->pos.x, p->pos.y, p->pos.z, dt, p->vel.x, p->vel.z,
            res.accepted ? "accepted" : "rejected",
            res.clamped ? "(地形容差夹紧)" : "");
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
    if (it != conns_.end()) {
      // S2C_CONSOLE 文本经 Writer::str 走 u8 长度前缀，单帧上限 255 字节。
      // help / entities / players 等长文本按 <=250 字节在 UTF-8 字符边界切分为多帧，
      // 客户端按流式重组（console.js 的 pendingPartial：以 '\n' 拼行、半行续接）。
      const size_t kMaxChunk = 250;
      size_t i = 0, n = all.size();
      while (i < n) {
        size_t end = i + kMaxChunk;
        if (end > n) end = n;
        // 回退到 UTF-8 字符起始，避免把多字节字符切到两帧（否则客户端逐帧解码会出现乱码）
        while (end < n && ((unsigned char)all[end] & 0xC0) == 0x80) end--;
        sendTo(it->second, proto::consoleFrame(all.substr(i, end - i)));
        i = end;
      }
    }
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
// 物品系统持久化（装备实例化）：
// equipJson = {"slots":[{slot,instId,itemId,enhance,locked}], "bag":[{instId,itemId,enhance,locked}]}
static std::string serializeEquip(const Entity& e) {
  Json o = Json::object();
  Json slots = Json::array();
  for (int i = 0; i < (int)e.pl.equip.size(); i++) {
    const ItemInstance& ins = e.pl.equip[i];
    if (!ins.instId) continue;
    Json so = Json::object();
    so["slot"] = (int64_t)GameData::indexSlot(i);  // 槽位值 1..6
    so["instId"] = (int64_t)ins.instId;
    so["itemId"] = (int64_t)ins.itemId;
    so["enhance"] = (int64_t)ins.enhance;
    so["locked"] = ins.locked;
    slots.push_back(so);
  }
  o["slots"] = slots;
  Json bag = Json::array();
  for (const auto& ins : e.pl.equipBag) {
    Json bo = Json::object();
    bo["instId"] = (int64_t)ins.instId;
    bo["itemId"] = (int64_t)ins.itemId;
    bo["enhance"] = (int64_t)ins.enhance;
    bo["locked"] = ins.locked;
    bag.push_back(bo);
  }
  o["bag"] = bag;
  return o.dump();
}
// 背包 itemId->数量 -> JSON {"2001":5,...}
static std::string serializeInventory(const std::unordered_map<uint32_t, uint32_t>& inv) {
  Json o = Json::object();
  for (const auto& [id, cnt] : inv) o[std::to_string(id)] = (int64_t)cnt;
  return o.dump();
}
// 从存档 JSON 恢复玩家背包/装备（含旧档迁移：旧格式无实例→自动分配 instId）
void applySaveItems(World& w, Entity& p, const PlayerSave& ps) {
  uint64_t maxInst = 0;
  auto readInst = [&](const Json& o) {
    ItemInstance ins;
    ins.instId = (uint64_t)(o.has("instId") ? o.at("instId").asInt() : 0);
    ins.itemId = (uint32_t)(o.has("itemId") ? o.at("itemId").asInt() : 0);
    ins.enhance = (uint8_t)(o.has("enhance") ? o.at("enhance").asInt() : 0);
    ins.locked = o.has("locked") && o.at("locked").type() == Json::Type::Bool ? o.at("locked").asBool() : false;
    if (ins.instId == 0) ins.instId = w.allocInstId();  // 兜底：缺失 instId 则新分配
    if (ins.instId > maxInst) maxInst = ins.instId;
    return ins;
  };
  try {
    if (!ps.equipJson.empty()) {
      Json eq = Json::parse(ps.equipJson);
      if (eq.type() == Json::Type::Object) {
        if (eq.has("slots") || eq.has("bag")) {
          // 新格式：装备实例
          if (eq.has("slots") && eq.at("slots").type() == Json::Type::Array) {
            for (const auto& so : eq.at("slots").asArray()) {
              int idx;
              int slotVal = (int)(so.has("slot") ? so.at("slot").asInt() : 0);
              if (!GameData::slotIndex((EquipSlot)slotVal, idx)) continue;
              p.pl.equip[idx] = readInst(so);
            }
          }
          if (eq.has("bag") && eq.at("bag").type() == Json::Type::Array) {
            for (const auto& bo : eq.at("bag").asArray())
              p.pl.equipBag.push_back(readInst(bo));
          }
        } else {
          // 旧格式：{"helm":1001,...} 槽位键 -> itemId（无实例）→ 迁移为实例
          for (auto& [key, v] : eq.asObject()) {
            int idx;
            EquipSlot slot = GameData::slotFromJson(Json(key), EquipSlot::WEAPON);
            if (!GameData::slotIndex(slot, idx)) continue;
            uint32_t itemId = (uint32_t)v.asInt();
            if (!itemId) continue;
            ItemInstance ins;
            ins.instId = w.allocInstId();
            ins.itemId = itemId;
            if (ins.instId > maxInst) maxInst = ins.instId;
            p.pl.equip[idx] = ins;
          }
        }
      }
    }
    if (!ps.inventoryJson.empty()) {
      Json inv = Json::parse(ps.inventoryJson);
      if (inv.type() == Json::Type::Object) {
        for (auto& [idStr, cnt] : inv.asObject()) {
          uint32_t id = (uint32_t)atoi(idStr.c_str());
          uint32_t n = (uint32_t)cnt.asInt();
          if (!id || !n) continue;
          const ItemDef* def = w.data().item(id);
          if (def && def->type == ItemType::EQUIP) {
            // 旧档：装备曾按 itemId 堆叠 → 迁移为 n 个实例
            for (uint32_t i = 0; i < n; i++) {
              ItemInstance ins;
              ins.instId = w.allocInstId();
              ins.itemId = id;
              if (ins.instId > maxInst) maxInst = ins.instId;
              p.pl.equipBag.push_back(ins);
            }
          } else {
            p.pl.inventory[id] = n;
          }
        }
      }
    }
    // 仓库数据恢复（阶段5）：deserialize 内部含 try-catch，失败静默（保留空仓库）
    if (!ps.warehouseJson.empty()) w.warehouse().deserialize(ps.warehouseJson, p.pl.warehouse);
  } catch (const std::exception& e) {
    fprintf(stderr, "[save] 恢复背包失败: %s\n", e.what());
  }
  if (maxInst) w.setInstIdFloor(maxInst);   // 扩展实例 ID 水位，避免新分配与旧档冲突
}

void GameServer::savePlayerToStore(const Entity& e) {
  PlayerSave ps;
  ps.username = e.username;
  ps.x = (float)e.pos.x; ps.y = (float)e.pos.y; ps.z = (float)e.pos.z;
  ps.hp = (float)e.hp;
  ps.level = e.level;
  ps.exp = e.pl.exp;
  ps.gold = e.pl.gold;
  ps.equipJson = serializeEquip(e);
  ps.inventoryJson = serializeInventory(e.pl.inventory);
  ps.questsJson = world_.quests().serializeQuests(e);
  ps.warehouseJson = world_.warehouse().serialize(e.pl.warehouse);   // 仓库数据（阶段5）
  // 存档时间戳取逻辑时钟（原点=本次进程启动），故它只表示「本进程内的相对时刻」，
  // 跨重启不可比：不可用于「最后登录时间」展示、也不可据此按自然日判定。若需要真实
  // 时间语义，应改存 system_clock 的 Unix 毫秒（steady_clock 同样不可用——其原点也是
  // 系统启动，跨重启不可比）。此处仅做时钟表达式收口，不改语义。
  ps.updatedAtMs = world_.logicNowMs();
  store_.savePlayer(ps);
  // 任务数据单独存储（便于独立加载）
  store_.saveQuests(e.username, ps.questsJson);
  // 装备实例 ID 计数器持久化（跨重启唯一性；仅 MySQL 模式生效）
  world_.saveInstIdCounter();
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
// ---- 社交系统辅助方法 ----
void GameServer::sendToPlayer(const std::string& username, const std::string& frame) {
  Entity* p = world_.findPlayerByUsername(username);
  if (!p) return;
  int fd = fdOfPlayer(p->id);
  if (fd < 0) return;
  auto it = conns_.find(fd);
  if (it != conns_.end() && it->second.phase == Conn::Ws) {
    enqueue(it->second, wsEncodeFrame(WS_BINARY, frame));
  }
}
void GameServer::broadcastToFriends(const std::string& username, const std::string& frame) {
  auto friends = world_.friends().getFriends(username);
  for (const auto& f : friends) {
    sendToPlayer(f, frame);
  }
}
void GameServer::broadcastToGuild(uint32_t guildId, const std::string& frame) {
  const Guild* g = world_.guilds().getGuild(guildId);
  if (!g) return;
  for (const auto& m : g->members) {
    sendToPlayer(m.username, frame);
  }
}
void GameServer::broadcastWorld(const std::string& frame) {
  for (const auto& pid : world_.players()) {
    Entity* p = world_.findEntity(pid);
    if (!p) continue;
    int fd = fdOfPlayer(p->id);
    if (fd < 0) continue;
    auto it = conns_.find(fd);
    if (it != conns_.end() && it->second.phase == Conn::Ws) {
      enqueue(it->second, wsEncodeFrame(WS_BINARY, frame));
    }
  }
}
} // namespace ew
