// chat.h - 聊天系统（大型网游规模：多频道 + 限流 + 离线信箱 + 历史回看）
#pragma once
#include <string>
#include <unordered_map>
#include <deque>
#include <vector>
#include <cstdint>

namespace ew {

class World;

// 聊天频道
enum ChatChannel : uint8_t {
  CHAT_PRIVATE = 0,  // 私聊（点对点）
  CHAT_FRIEND  = 1,  // 好友频道（广播给所有在线好友）
  CHAT_GUILD   = 2,  // 公会频道（广播给公会在线成员）
  CHAT_WORLD   = 3,  // 世界频道（全区广播）
  CHAT_TEAM    = 4,  // 队伍频道（预留）
  CHAT_SYSTEM  = 5,  // 系统消息（服务端推送）
};

// 聊天消息
struct ChatMessage {
  ChatChannel channel;
  std::string senderName;
  uint32_t senderWid = 0;
  std::string targetName;
  std::string content;
  uint64_t timestampMs = 0;
};

// 聊天操作结果码
enum ChatResult : uint8_t {
  CHAT_OK = 0,
  CHAT_ERR_TARGET_OFFLINE = 1,  // 目标离线（已存入信箱）
  CHAT_ERR_TARGET_NOT_FOUND = 2,// 目标不存在
  CHAT_ERR_SELF = 3,            // 不能私聊自己
  CHAT_ERR_BLOCKED = 4,         // 被对方拉黑
  CHAT_ERR_NOT_IN_GUILD = 5,    // 不在公会
  CHAT_ERR_RATE_LIMIT = 6,      // 发言频率限制
  CHAT_ERR_TOO_LONG = 7,        // 消息过长
  CHAT_ERR_EMPTY = 8,           // 消息为空
  CHAT_ERR_INVALID_CHANNEL = 9, // 无效频道
};

class ChatSystem {
public:
  explicit ChatSystem(World& w) : world_(w) {}

  // 发送消息（返回结果 + 需要通知的目标玩家列表）
  struct SendResult {
    ChatResult code;
    std::vector<std::string> recipients; // 需要发送帧的目标玩家
    ChatMessage msg;                     // 构建好的消息
  };

  SendResult sendMessage(const std::string& sender, ChatChannel channel,
                         const std::string& target, const std::string& content);

  // 获取世界频道历史（新登录时回看）
  std::vector<ChatMessage> getWorldHistory(uint32_t count = 20) const;

  // 取出离线消息（取出后清空）
  std::vector<ChatMessage> takeOfflineMessages(const std::string& username);

  // 添加系统消息（服务端事件触发）
  void sendSystemMessage(const std::string& target, const std::string& content);
  void broadcastSystemMessage(const std::string& content);

  // 获取待推送的系统消息（调用后清空）
  std::vector<std::pair<std::string, ChatMessage>> takeSystemMessages();
  std::vector<ChatMessage> takeBroadcastMessages();

private:
  World& world_;
  // 世界频道历史（环形缓冲）
  std::deque<ChatMessage> worldHistory_;
  // 离线信箱
  std::unordered_map<std::string, std::deque<ChatMessage>> offlineMail_;
  // 限流: username -> 上次发送时间
  std::unordered_map<std::string, uint64_t> lastChatMs_;
  // 待推送的系统消息
  std::vector<std::pair<std::string, ChatMessage>> pendingSystemMsgs_;
  std::vector<ChatMessage> pendingBroadcastMsgs_;

  bool checkRateLimit(const std::string& username, ChatChannel channel) const;
  void addToWorldHistory(const ChatMessage& msg);
  void addToOfflineMail(const std::string& target, const ChatMessage& msg);
  std::string filterContent(const std::string& content) const;
};

} // namespace ew
