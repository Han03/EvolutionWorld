// friends.h - 好友系统（大型网游规模：双向关系 + 请求队列 + 黑名单 + 在线状态通知）
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <cstdint>
#include "util/json.h"

namespace ew {

class World;

// 好友请求
struct FriendRequest {
  std::string fromUser;
  std::string toUser;
  uint64_t timestampMs = 0;
  std::string message;
};

// 好友操作结果码
enum FriendResult : uint8_t {
  FRIEND_OK = 0,
  FRIEND_ERR_NOT_FOUND = 1,     // 目标玩家不存在
  FRIEND_ERR_SELF = 2,          // 不能加自己
  FRIEND_ERR_ALREADY = 3,       // 已经是好友
  FRIEND_ERR_FULL = 4,          // 好友列表已满
  FRIEND_ERR_BLOCKED = 5,       // 被对方拉黑
  FRIEND_ERR_REQ_FULL = 6,      // 请求队列已满
  FRIEND_ERR_NO_REQUEST = 7,    // 没有找到请求
  FRIEND_ERR_BLOCK_SELF = 8,    // 不能拉黑自己
};

// 好友操作码（供客户端识别操作类型）
enum FriendOp : uint8_t {
  FRIEND_OP_ADD = 0,
  FRIEND_OP_ACCEPT = 1,
  FRIEND_OP_REJECT = 2,
  FRIEND_OP_REMOVE = 3,
  FRIEND_OP_BLOCK = 4,
  FRIEND_OP_UNBLOCK = 5,
};

class FriendSystem {
public:
  explicit FriendSystem(World& w) : world_(w) {}

  // 初始化：从存储加载好友/黑名单数据
  void init();

  // 发送好友请求
  FriendResult sendRequest(const std::string& from, const std::string& to, const std::string& message);
  // 接受好友请求
  FriendResult acceptRequest(const std::string& to, const std::string& from);
  // 拒绝好友请求
  FriendResult rejectRequest(const std::string& to, const std::string& from);
  // 删除好友
  FriendResult removeFriend(const std::string& a, const std::string& b);
  // 拉黑
  FriendResult blockUser(const std::string& a, const std::string& b);
  // 取消拉黑
  FriendResult unblockUser(const std::string& a, const std::string& b);

  // 查询
  bool isFriend(const std::string& a, const std::string& b) const;
  bool isBlocked(const std::string& a, const std::string& b) const;
  std::vector<std::string> getFriends(const std::string& username) const;
  std::vector<FriendRequest> getPendingRequests(const std::string& username) const;

  // 上线/下线通知（登录/登出时调用）
  void onPlayerLogin(const std::string& username);
  void onPlayerLogout(const std::string& username);

  // 构建好友列表帧数据（含在线状态）
  std::vector<std::tuple<std::string, bool, std::string>> buildFriendList(const std::string& username) const;

private:
  World& world_;
  // 好友列表: username -> set<friend_username>（双向，添加时两边都写）
  std::unordered_map<std::string, std::unordered_set<std::string>> friends_;
  // 待处理请求: toUser -> vector<FriendRequest>
  std::unordered_map<std::string, std::vector<FriendRequest>> pendingRequests_;
  // 黑名单: username -> set<blocked_username>
  std::unordered_map<std::string, std::unordered_set<std::string>> blocks_;
};

} // namespace ew
