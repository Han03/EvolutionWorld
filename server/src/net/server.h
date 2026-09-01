// server.h - epoll 事件循环服务器：HTTP + WebSocket(二进制协议) + 游戏 tick + 防作弊接线
#pragma once
#include <unordered_map>
#include <string>
#include <cstdint>
#include "net/http.h"
#include "game/world.h"
#include "game/netcode.h"
#include "auth/auth.h"
#include "anticheat/anticheat.h"
#include "store/store.h"
#include "net/protocol.h"
#include "../config.h"
namespace ew {
class GameServer {
public:
  GameServer(const Config& cfg, World& world, Auth& auth, AntiCheat& ac, Store& store)
      : cfg_(cfg), world_(world), auth_(auth), ac_(ac), store_(store), netcode_(world, cfg) {}
  bool start();
  void run();
  void stop();
private:
  struct Conn {
    int fd = -1;
    enum Phase { Http, Ws } phase = Http;   // 不再有 Closed：用 closeAfterFlush 驱动关闭
    std::string inBuf;
    std::string outBuf;
    bool closeAfterFlush = false;           // 响应写完即关闭
    bool outWatching = false;
    // WS 分片状态
    std::string wsPartial;
    bool wsFragmented = false;
    std::string playerId;
  };
  void acceptNew();
  void onReadable(Conn& c);
  void onWritable(Conn& c);
  void closeConn(int fd);
  void enqueue(Conn& c, const std::string& data);
  void handleHttp(Conn& c, const HttpRequest& req);
  void handleWsFrame(Conn& c, bool fin, int opcode, const std::string& payload);
  void handleBinary(Conn& c, const std::string& payload);
  void handleInput(Conn& c, const proto::InputMsg& in);
  void broadcastTick();
  void savePlayerToStore(const Entity& e);
  void periodicSavePlayers();
  void sendTo(Conn& c, const std::string& frame);
  int fdOfPlayer(const std::string& playerId) const;
  static uint64_t steadyMs();
  const Config& cfg_;
  World& world_;
  Auth& auth_;
  AntiCheat& ac_;
  Store& store_;
  Netcode netcode_;
  int listenFd_ = -1;
  int epollFd_ = -1;
  bool running_ = false;
  std::unordered_map<int, Conn> conns_;
  uint64_t nextTickMs_ = 0;
};
} // namespace ew
