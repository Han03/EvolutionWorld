// chat.cpp - 聊天系统实现
#include "chat.h"
#include "world.h"
#include "friends.h"
#include "guild.h"
#include <algorithm>
#include <ctime>

namespace ew {

static uint64_t steadyMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

ChatSystem::SendResult ChatSystem::sendMessage(const std::string& sender, ChatChannel channel,
                                                const std::string& target, const std::string& content) {
  SendResult result;
  result.code = CHAT_OK;

  // 基本校验
  if (content.empty()) { result.code = CHAT_ERR_EMPTY; return result; }
  if (content.size() > world_.config().chatMaxLen) { result.code = CHAT_ERR_TOO_LONG; return result; }
  if (channel > CHAT_SYSTEM) { result.code = CHAT_ERR_INVALID_CHANNEL; return result; }

  // 限流检查
  if (!checkRateLimit(sender, channel)) { result.code = CHAT_ERR_RATE_LIMIT; return result; }

  // 获取发送者实体
  Entity* senderEnt = world_.findPlayerByUsername(sender);
  if (!senderEnt) { result.code = CHAT_ERR_TARGET_NOT_FOUND; return result; }

  // 构建消息
  ChatMessage msg;
  msg.channel = channel;
  msg.senderName = sender;
  msg.senderWid = senderEnt->wid;
  msg.targetName = target;
  msg.content = filterContent(content);
  msg.timestampMs = steadyMs();

  switch (channel) {
    case CHAT_PRIVATE: {
      // 私聊
      if (sender == target) { result.code = CHAT_ERR_SELF; return result; }
      // 检查是否被拉黑
      if (world_.friends().isBlocked(target, sender)) { result.code = CHAT_ERR_BLOCKED; return result; }
      // 目标在线
      Entity* targetEnt = world_.findPlayerByUsername(target);
      if (targetEnt) {
        result.recipients.push_back(target);
      } else {
        // 离线存入信箱
        addToOfflineMail(target, msg);
        result.code = CHAT_ERR_TARGET_OFFLINE;
      }
      break;
    }
    case CHAT_FRIEND: {
      // 好友频道：广播给所有在线好友
      auto friends = world_.friends().getFriends(sender);
      for (const auto& f : friends) {
        if (world_.findPlayerByUsername(f)) {
          result.recipients.push_back(f);
        }
      }
      break;
    }
    case CHAT_GUILD: {
      // 公会频道
      uint32_t guildId = world_.guilds().getPlayerGuildId(sender);
      if (guildId == 0) { result.code = CHAT_ERR_NOT_IN_GUILD; return result; }
      const Guild* g = world_.guilds().getGuild(guildId);
      if (!g) { result.code = CHAT_ERR_NOT_IN_GUILD; return result; }
      for (const auto& m : g->members) {
        if (m.username != sender && world_.findPlayerByUsername(m.username)) {
          result.recipients.push_back(m.username);
        }
      }
      break;
    }
    case CHAT_WORLD: {
      // 世界频道：全区广播
      for (const auto& pid : world_.players()) {
        Entity* p = world_.findEntity(pid);
        if (p && p->username != sender) {
          result.recipients.push_back(p->username);
        }
      }
      // 加入历史
      addToWorldHistory(msg);
      break;
    }
    case CHAT_TEAM: {
      // 队伍频道（预留）
      result.code = CHAT_ERR_INVALID_CHANNEL;
      return result;
    }
    case CHAT_SYSTEM: {
      // 系统消息不允许玩家发送
      result.code = CHAT_ERR_INVALID_CHANNEL;
      return result;
    }
  }

  // 更新限流时间
  lastChatMs_[sender] = steadyMs();
  result.msg = msg;
  return result;
}

std::vector<ChatMessage> ChatSystem::getWorldHistory(uint32_t count) const {
  std::vector<ChatMessage> result;
  uint32_t n = std::min(count, (uint32_t)worldHistory_.size());
  auto it = worldHistory_.end() - n;
  for (; it != worldHistory_.end(); ++it) {
    result.push_back(*it);
  }
  return result;
}

std::vector<ChatMessage> ChatSystem::takeOfflineMessages(const std::string& username) {
  auto it = offlineMail_.find(username);
  if (it == offlineMail_.end()) return {};
  std::vector<ChatMessage> result(it->second.begin(), it->second.end());
  offlineMail_.erase(it);
  return result;
}

void ChatSystem::sendSystemMessage(const std::string& target, const std::string& content) {
  ChatMessage msg;
  msg.channel = CHAT_SYSTEM;
  msg.senderName = "system";
  msg.content = content;
  msg.timestampMs = steadyMs();
  pendingSystemMsgs_.push_back({target, msg});
}

void ChatSystem::broadcastSystemMessage(const std::string& content) {
  ChatMessage msg;
  msg.channel = CHAT_SYSTEM;
  msg.senderName = "system";
  msg.content = content;
  msg.timestampMs = steadyMs();
  pendingBroadcastMsgs_.push_back(msg);
}

std::vector<std::pair<std::string, ChatMessage>> ChatSystem::takeSystemMessages() {
  auto out = std::move(pendingSystemMsgs_);
  pendingSystemMsgs_.clear();
  return out;
}

std::vector<ChatMessage> ChatSystem::takeBroadcastMessages() {
  auto out = std::move(pendingBroadcastMsgs_);
  pendingBroadcastMsgs_.clear();
  return out;
}

bool ChatSystem::checkRateLimit(const std::string& username, ChatChannel channel) const {
  auto it = lastChatMs_.find(username);
  if (it == lastChatMs_.end()) return true;

  uint64_t now = steadyMs();
  uint64_t minInterval = world_.config().chatMinIntervalMs;
  if (channel == CHAT_WORLD) {
    minInterval = world_.config().chatWorldCooldownMs;
  }

  return (now - it->second) >= minInterval;
}

void ChatSystem::addToWorldHistory(const ChatMessage& msg) {
  worldHistory_.push_back(msg);
  while (worldHistory_.size() > world_.config().chatWorldHistorySize) {
    worldHistory_.pop_front();
  }
}

void ChatSystem::addToOfflineMail(const std::string& target, const ChatMessage& msg) {
  auto& mail = offlineMail_[target];
  mail.push_back(msg);
  while (mail.size() > world_.config().chatOfflineMaxMsgs) {
    mail.pop_front();
  }
}

std::string ChatSystem::filterContent(const std::string& content) const {
  // 简单实现：直接返回（后续可扩展敏感词过滤）
  return content;
}

} // namespace ew
