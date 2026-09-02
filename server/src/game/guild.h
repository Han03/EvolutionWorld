// guild.h - 公会系统（大型网游规模：层级角色 + 权限体系 + 申请审批）
#pragma once
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <cstdint>
#include "util/json.h"

namespace ew {

class World;
namespace proto { struct GuildInfoData; }

// 公会成员角色
enum GuildRole : uint8_t {
  GUILD_LEADER  = 0,   // 会长
  GUILD_OFFICER = 1,   // 副会长
  GUILD_MEMBER  = 2,   // 普通成员
  GUILD_RECRUIT = 3,   // 新成员（试用期）
};

// 公会成员
struct GuildMember {
  std::string username;
  GuildRole role = GUILD_RECRUIT;
  uint64_t joinMs = 0;
  uint64_t lastActiveMs = 0;
  uint64_t contributionPts = 0;
  std::string title;
};

// 入会申请
struct GuildApplication {
  std::string applicantName;
  uint64_t timestampMs = 0;
  std::string message;
};

// 公会
struct Guild {
  uint32_t guildId = 0;
  std::string name;
  std::string notice;
  std::string leaderUsername;
  uint32_t memberCount = 0;
  uint32_t maxMembers = 50;
  uint64_t createdMs = 0;
  uint64_t level = 1;
  uint64_t exp = 0;
  uint32_t logo = 0;
  std::vector<GuildMember> members;
  std::vector<GuildApplication> applications;
};

// 公会操作结果码
enum GuildResult : uint8_t {
  GUILD_OK = 0,
  GUILD_ERR_NOT_FOUND = 1,      // 公会不存在
  GUILD_ERR_ALREADY_IN = 2,     // 已在公会中
  GUILD_ERR_NOT_IN = 3,         // 不在公会中
  GUILD_ERR_NO_PERM = 4,        // 无权限
  GUILD_ERR_NAME_TAKEN = 5,     // 名称已存在
  GUILD_ERR_FULL = 6,           // 公会已满
  GUILD_ERR_NOT_ENOUGH_GOLD = 7,// 金币不足
  GUILD_ERR_NO_APPLICATION = 8, // 没有申请
  GUILD_ERR_TARGET_NOT_IN = 9,  // 目标不在公会中
  GUILD_ERR_CANNOT_KICK_LEADER = 10, // 不能踢会长
  GUILD_ERR_RANK_HIGHER = 11,   // 目标等级更高或相等
};

// 公会事件类型（供 S2C_GUILD_NOTIFY）
enum GuildNotifyType : uint8_t {
  GUILD_NOTIFY_NEW_MEMBER = 0,
  GUILD_NOTIFY_MEMBER_LEFT = 1,
  GUILD_NOTIFY_KICKED = 2,
  GUILD_NOTIFY_NOTICE = 3,
  GUILD_NOTIFY_PROMOTED = 4,
  GUILD_NOTIFY_DEMOTED = 5,
  GUILD_NOTIFY_DISBANDED = 6,
  GUILD_NOTIFY_TRANSFERRED = 7,
};

class GuildSystem {
public:
  explicit GuildSystem(World& w) : world_(w) {}

  // 初始化：从存储加载公会数据
  void init();

  // 创建公会
  GuildResult createGuild(const std::string& creator, const std::string& name);
  // 解散公会
  GuildResult disbandGuild(const std::string& leader);
  // 申请入会
  GuildResult applyToGuild(const std::string& applicant, uint32_t guildId, const std::string& message);
  // 审批入会
  GuildResult approveApplication(const std::string& officer, const std::string& applicant, bool approve);
  // 踢出成员
  GuildResult kickMember(const std::string& officer, const std::string& target);
  // 晋升
  GuildResult promoteMember(const std::string& officer, const std::string& target);
  // 降级
  GuildResult demoteMember(const std::string& officer, const std::string& target);
  // 主动退出
  GuildResult leaveGuild(const std::string& member);
  // 转让会长
  GuildResult transferLeadership(const std::string& leader, const std::string& target);
  // 编辑公告
  GuildResult editNotice(const std::string& officer, const std::string& notice);

  // 查询
  const Guild* getGuild(uint32_t guildId) const;
  const Guild* getPlayerGuild(const std::string& username) const;
  uint32_t getPlayerGuildId(const std::string& username) const;
  std::vector<Guild> searchGuilds(const std::string& keyword) const;

  // 获取公会信息帧数据
  bool buildGuildInfo(uint32_t guildId, proto::GuildInfoData& out) const;

  // 更新成员活跃时间
  void updateMemberActivity(const std::string& username);

private:
  World& world_;
  // 公会数据: guildId -> Guild
  std::unordered_map<uint32_t, Guild> guilds_;
  // 成员索引: username -> guildId
  std::unordered_map<std::string, uint32_t> memberIndex_;
  // 公会名称索引: name -> guildId
  std::unordered_map<std::string, uint32_t> nameIndex_;
  // ID 分配
  uint32_t nextGuildId_ = 1;

  // 权限检查
  bool hasPermission(uint32_t guildId, const std::string& username, GuildRole minRole) const;
  GuildRole getMemberRole(uint32_t guildId, const std::string& username) const;
  GuildMember* findMember(uint32_t guildId, const std::string& username);
  const GuildMember* findMember(uint32_t guildId, const std::string& username) const;
};

} // namespace ew
