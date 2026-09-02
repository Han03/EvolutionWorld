// friends.cpp - 好友系统实现
#include "friends.h"
#include "world.h"
#include "store/store.h"
#include <algorithm>
#include <ctime>

namespace ew {

static uint64_t steadyMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

void FriendSystem::init() {
  // 从存储层加载好友关系和黑名单（内存兜底模式下为空）
  // 实际加载在 World 初始化时通过 Store 调用完成
}

FriendResult FriendSystem::sendRequest(const std::string& from, const std::string& to, const std::string& message) {
  if (from == to) return FRIEND_ERR_SELF;
  if (isFriend(from, to)) return FRIEND_ERR_ALREADY;
  if (isBlocked(to, from)) return FRIEND_ERR_BLOCKED;

  // 检查好友上限
  if (friends_[from].size() >= world_.config().maxFriends) return FRIEND_ERR_FULL;
  if (friends_[to].size() >= world_.config().maxFriends) return FRIEND_ERR_FULL;

  // 检查请求队列上限
  auto& reqs = pendingRequests_[to];
  if (reqs.size() >= world_.config().maxFriendRequests) return FRIEND_ERR_REQ_FULL;

  // 检查是否已有相同请求
  for (const auto& r : reqs) {
    if (r.fromUser == from) return FRIEND_ERR_ALREADY; // 已发送过请求
  }

  // 添加请求
  FriendRequest req;
  req.fromUser = from;
  req.toUser = to;
  req.timestampMs = steadyMs();
  req.message = message;
  reqs.push_back(req);

  return FRIEND_OK;
}

FriendResult FriendSystem::acceptRequest(const std::string& to, const std::string& from) {
  // 查找请求
  auto it = pendingRequests_.find(to);
  if (it == pendingRequests_.end()) return FRIEND_ERR_NO_REQUEST;

  auto& reqs = it->second;
  auto reqIt = std::find_if(reqs.begin(), reqs.end(),
      [&](const FriendRequest& r) { return r.fromUser == from; });
  if (reqIt == reqs.end()) return FRIEND_ERR_NO_REQUEST;

  // 双向添加好友
  friends_[from].insert(to);
  friends_[to].insert(from);

  // 移除请求
  reqs.erase(reqIt);

  // 持久化
  world_.store().addFriend(from, to);

  return FRIEND_OK;
}

FriendResult FriendSystem::rejectRequest(const std::string& to, const std::string& from) {
  auto it = pendingRequests_.find(to);
  if (it == pendingRequests_.end()) return FRIEND_ERR_NO_REQUEST;

  auto& reqs = it->second;
  auto reqIt = std::find_if(reqs.begin(), reqs.end(),
      [&](const FriendRequest& r) { return r.fromUser == from; });
  if (reqIt == reqs.end()) return FRIEND_ERR_NO_REQUEST;

  reqs.erase(reqIt);
  return FRIEND_OK;
}

FriendResult FriendSystem::removeFriend(const std::string& a, const std::string& b) {
  if (!isFriend(a, b)) return FRIEND_ERR_NOT_FOUND;

  friends_[a].erase(b);
  friends_[b].erase(a);

  // 持久化
  world_.store().removeFriend(a, b);

  return FRIEND_OK;
}

FriendResult FriendSystem::blockUser(const std::string& a, const std::string& b) {
  if (a == b) return FRIEND_ERR_BLOCK_SELF;

  blocks_[a].insert(b);

  // 如果已经是好友，同时移除好友关系
  if (isFriend(a, b)) {
    friends_[a].erase(b);
    friends_[b].erase(a);
    world_.store().removeFriend(a, b);
  }

  // 移除可能存在的待处理请求
  auto it = pendingRequests_.find(a);
  if (it != pendingRequests_.end()) {
    auto& reqs = it->second;
    reqs.erase(std::remove_if(reqs.begin(), reqs.end(),
        [&](const FriendRequest& r) { return r.fromUser == b; }), reqs.end());
  }

  world_.store().addBlock(a, b);

  return FRIEND_OK;
}

FriendResult FriendSystem::unblockUser(const std::string& a, const std::string& b) {
  auto it = blocks_.find(a);
  if (it == blocks_.end() || it->second.count(b) == 0) return FRIEND_ERR_NOT_FOUND;

  it->second.erase(b);
  world_.store().removeBlock(a, b);

  return FRIEND_OK;
}

bool FriendSystem::isFriend(const std::string& a, const std::string& b) const {
  auto it = friends_.find(a);
  if (it == friends_.end()) return false;
  return it->second.count(b) > 0;
}

bool FriendSystem::isBlocked(const std::string& a, const std::string& b) const {
  auto it = blocks_.find(a);
  if (it == blocks_.end()) return false;
  return it->second.count(b) > 0;
}

std::vector<std::string> FriendSystem::getFriends(const std::string& username) const {
  auto it = friends_.find(username);
  if (it == friends_.end()) return {};
  return {it->second.begin(), it->second.end()};
}

std::vector<FriendRequest> FriendSystem::getPendingRequests(const std::string& username) const {
  auto it = pendingRequests_.find(username);
  if (it == pendingRequests_.end()) return {};
  return it->second;
}

void FriendSystem::onPlayerLogin(const std::string& username) {
  // 返回需要通知的好友列表（由 Server 层发送帧）
  // 这里只记录日志，实际通知由 Server 层处理
  fprintf(stderr, "[friends] %s 上线\n", username.c_str());
}

void FriendSystem::onPlayerLogout(const std::string& username) {
  fprintf(stderr, "[friends] %s 下线\n", username.c_str());
}

std::vector<std::tuple<std::string, bool, std::string>> FriendSystem::buildFriendList(const std::string& username) const {
  std::vector<std::tuple<std::string, bool, std::string>> result;
  auto it = friends_.find(username);
  if (it == friends_.end()) return result;

  for (const auto& friendName : it->second) {
    bool online = (world_.findPlayerByUsername(friendName) != nullptr);
    result.emplace_back(friendName, online, ""); // remark 暂空
  }
  return result;
}

} // namespace ew
