// guild.cpp - 公会系统实现
#include "guild.h"
#include "world.h"
#include "store/store.h"
#include "net/protocol.h"
#include <algorithm>
#include <ctime>

namespace ew {

static uint64_t steadyMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

// ---- 公会成员序列化/反序列化（JSON）----
static std::string guildMembersToJson(const std::vector<GuildMember>& members) {
  Json arr = Json::array();
  for (const auto& m : members) {
    Json j = Json::object();
    j["username"] = m.username;
    j["role"] = (int64_t)m.role;
    j["joinMs"] = (int64_t)m.joinMs;
    j["lastActiveMs"] = (int64_t)m.lastActiveMs;
    j["contributionPts"] = (int64_t)m.contributionPts;
    j["title"] = m.title;
    arr.push_back(j);
  }
  return arr.dump();
}
static std::vector<GuildMember> guildMembersFromJson(const std::string& json) {
  std::vector<GuildMember> out;
  if (json.empty()) return out;
  try {
    Json arr = Json::parse(json);
    if (arr.type() != Json::Type::Array) return out;
    for (const auto& j : arr.asArray()) {
      GuildMember m;
      if (j.has("username")) m.username = j.at("username").asString();
      if (j.has("role")) m.role = (GuildRole)j.at("role").asInt();
      if (j.has("joinMs")) m.joinMs = (uint64_t)j.at("joinMs").asInt();
      if (j.has("lastActiveMs")) m.lastActiveMs = (uint64_t)j.at("lastActiveMs").asInt();
      if (j.has("contributionPts")) m.contributionPts = (uint64_t)j.at("contributionPts").asInt();
      if (j.has("title")) m.title = j.at("title").asString();
      out.push_back(std::move(m));
    }
  } catch (...) {}
  return out;
}

void GuildSystem::init() {
  // 从存储层加载公会数据
  auto ids = world_.store().loadAllGuildIds();
  for (uint32_t id : ids) {
    GuildSave gs;
    if (world_.store().loadGuild(id, gs)) {
      Guild g;
      g.guildId = gs.guildId;
      g.name = gs.name;
      g.notice = gs.notice;
      g.leaderUsername = gs.leaderUsername;
      g.memberCount = gs.memberCount;
      g.maxMembers = gs.maxMembers;
      g.createdMs = gs.createdMs;
      g.level = gs.level;
      g.exp = gs.exp;
      g.logo = gs.logo;
      // 加载公会成员
      std::string mj = world_.store().loadGuildMembers(id);
      g.members = guildMembersFromJson(mj);
      // 重建成员索引
      for (const auto& m : g.members) {
        memberIndex_[m.username] = id;
      }
      guilds_[id] = g;
      nameIndex_[g.name] = id;
      if (id >= nextGuildId_) nextGuildId_ = id + 1;
    }
  }
  fprintf(stderr, "[guild] 从存储层加载完成：%zu 个公会\n", guilds_.size());
}

GuildResult GuildSystem::createGuild(const std::string& creator, const std::string& name) {
  // 检查是否已在公会
  if (memberIndex_.count(creator)) return GUILD_ERR_ALREADY_IN;
  // 检查名称
  if (nameIndex_.count(name)) return GUILD_ERR_NAME_TAKEN;
  // 检查金币
  Entity* p = world_.findPlayerByUsername(creator);
  if (!p) return GUILD_ERR_NOT_FOUND;
  if (p->pl.gold < world_.config().guildCreateCost) return GUILD_ERR_NOT_ENOUGH_GOLD;

  // 扣金币
  p->pl.gold -= world_.config().guildCreateCost;
  world_.markInvDirty(creator);

  // 创建公会
  uint32_t guildId = nextGuildId_++;
  Guild g;
  g.guildId = guildId;
  g.name = name;
  g.leaderUsername = creator;
  g.memberCount = 1;
  g.maxMembers = world_.config().maxGuildMembers;
  g.createdMs = steadyMs();

  // 创建者自动成为会长
  GuildMember leader;
  leader.username = creator;
  leader.role = GUILD_LEADER;
  leader.joinMs = g.createdMs;
  leader.lastActiveMs = g.createdMs;
  g.members.push_back(leader);

  guilds_[guildId] = g;
  memberIndex_[creator] = guildId;
  nameIndex_[name] = guildId;

  // 持久化
  GuildSave gs;
  gs.guildId = guildId;
  gs.name = name;
  gs.leaderUsername = creator;
  gs.memberCount = 1;
  gs.maxMembers = g.maxMembers;
  gs.createdMs = g.createdMs;
  world_.store().saveGuild(gs);
  world_.store().saveGuildMembers(guildId, guildMembersToJson(g.members));

  fprintf(stderr, "[guild] %s 创建公会 [%s] (id=%u)\n", creator.c_str(), name.c_str(), guildId);
  return GUILD_OK;
}

GuildResult GuildSystem::disbandGuild(const std::string& leader) {
  auto it = memberIndex_.find(leader);
  if (it == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = it->second;
  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = git->second;
  if (g.leaderUsername != leader) return GUILD_ERR_NO_PERM;

  // 清除所有成员的索引
  for (const auto& m : g.members) {
    memberIndex_.erase(m.username);
  }
  nameIndex_.erase(g.name);
  world_.store().deleteGuild(guildId);
  guilds_.erase(git);

  fprintf(stderr, "[guild] 公会 [%s] (id=%u) 已解散\n", g.name.c_str(), guildId);
  return GUILD_OK;
}

GuildResult GuildSystem::applyToGuild(const std::string& applicant, uint32_t guildId, const std::string& message) {
  if (memberIndex_.count(applicant)) return GUILD_ERR_ALREADY_IN;

  auto it = guilds_.find(guildId);
  if (it == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = it->second;
  if (g.memberCount >= g.maxMembers) return GUILD_ERR_FULL;
  if (g.applications.size() >= world_.config().maxGuildApplications) return GUILD_ERR_FULL;

  // 检查是否已申请
  for (const auto& a : g.applications) {
    if (a.applicantName == applicant) return GUILD_ERR_ALREADY_IN;
  }

  GuildApplication app;
  app.applicantName = applicant;
  app.timestampMs = steadyMs();
  app.message = message;
  g.applications.push_back(app);

  return GUILD_OK;
}

GuildResult GuildSystem::approveApplication(const std::string& officer, const std::string& applicant, bool approve) {
  auto it = memberIndex_.find(officer);
  if (it == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = it->second;
  if (!hasPermission(guildId, officer, GUILD_OFFICER)) return GUILD_ERR_NO_PERM;

  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = git->second;

  // 查找申请
  auto appIt = std::find_if(g.applications.begin(), g.applications.end(),
      [&](const GuildApplication& a) { return a.applicantName == applicant; });
  if (appIt == g.applications.end()) return GUILD_ERR_NO_APPLICATION;

  if (!approve) {
    g.applications.erase(appIt);
    return GUILD_OK;
  }

  // 通过申请
  if (g.memberCount >= g.maxMembers) return GUILD_ERR_FULL;

  g.applications.erase(appIt);

  GuildMember m;
  m.username = applicant;
  m.role = GUILD_RECRUIT;
  m.joinMs = steadyMs();
  m.lastActiveMs = m.joinMs;
  g.members.push_back(m);
  g.memberCount++;
  memberIndex_[applicant] = guildId;

  // 持久化
  GuildSave gs;
  gs.guildId = guildId;
  gs.name = g.name;
  gs.notice = g.notice;
  gs.leaderUsername = g.leaderUsername;
  gs.memberCount = g.memberCount;
  gs.maxMembers = g.maxMembers;
  gs.createdMs = g.createdMs;
  gs.level = g.level;
  gs.exp = g.exp;
  gs.logo = g.logo;
  world_.store().saveGuild(gs);
  world_.store().saveGuildMembers(guildId, guildMembersToJson(g.members));

  fprintf(stderr, "[guild] %s 加入公会 [%s]\n", applicant.c_str(), g.name.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::kickMember(const std::string& officer, const std::string& target) {
  auto oit = memberIndex_.find(officer);
  if (oit == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = oit->second;
  auto tit = memberIndex_.find(target);
  if (tit == memberIndex_.end() || tit->second != guildId) return GUILD_ERR_TARGET_NOT_IN;

  if (!hasPermission(guildId, officer, GUILD_OFFICER)) return GUILD_ERR_NO_PERM;

  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = git->second;

  // 不能踢会长
  if (target == g.leaderUsername) return GUILD_ERR_CANNOT_KICK_LEADER;

  // 检查权限等级（只能踢同级或低级）
  GuildRole officerRole = getMemberRole(guildId, officer);
  GuildRole targetRole = getMemberRole(guildId, target);
  if (targetRole < officerRole) return GUILD_ERR_RANK_HIGHER; // 数值越小等级越高

  // 移除成员
  auto mit = std::find_if(g.members.begin(), g.members.end(),
      [&](const GuildMember& m) { return m.username == target; });
  if (mit != g.members.end()) g.members.erase(mit);
  g.memberCount--;
  memberIndex_.erase(target);
  world_.store().saveGuildMembers(guildId, guildMembersToJson(g.members));

  fprintf(stderr, "[guild] %s 被踢出公会 [%s]\n", target.c_str(), g.name.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::promoteMember(const std::string& officer, const std::string& target) {
  auto oit = memberIndex_.find(officer);
  if (oit == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = oit->second;
  if (!hasPermission(guildId, officer, GUILD_LEADER)) return GUILD_ERR_NO_PERM;

  GuildMember* m = findMember(guildId, target);
  if (!m) return GUILD_ERR_TARGET_NOT_IN;

  // 晋升：RECRUIT -> MEMBER -> OFFICER
  if (m->role == GUILD_RECRUIT) m->role = GUILD_MEMBER;
  else if (m->role == GUILD_MEMBER) m->role = GUILD_OFFICER;
  else return GUILD_ERR_RANK_HIGHER; // 已经是副会长或会长

  fprintf(stderr, "[guild] %s 晋升 %s\n", officer.c_str(), target.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::demoteMember(const std::string& officer, const std::string& target) {
  auto oit = memberIndex_.find(officer);
  if (oit == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = oit->second;
  if (!hasPermission(guildId, officer, GUILD_LEADER)) return GUILD_ERR_NO_PERM;

  GuildMember* m = findMember(guildId, target);
  if (!m) return GUILD_ERR_TARGET_NOT_IN;

  // 降级：OFFICER -> MEMBER -> RECRUIT
  if (m->role == GUILD_OFFICER) m->role = GUILD_MEMBER;
  else if (m->role == GUILD_MEMBER) m->role = GUILD_RECRUIT;
  else return GUILD_ERR_RANK_HIGHER; // 已经是新成员或会长

  fprintf(stderr, "[guild] %s 降级 %s\n", officer.c_str(), target.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::leaveGuild(const std::string& member) {
  auto it = memberIndex_.find(member);
  if (it == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = it->second;
  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = git->second;

  // 会长退出 = 解散
  if (g.leaderUsername == member) {
    return disbandGuild(member);
  }

  // 移除成员
  auto mit = std::find_if(g.members.begin(), g.members.end(),
      [&](const GuildMember& m) { return m.username == member; });
  if (mit != g.members.end()) g.members.erase(mit);
  g.memberCount--;
  memberIndex_.erase(member);
  world_.store().saveGuildMembers(guildId, guildMembersToJson(g.members));

  fprintf(stderr, "[guild] %s 退出公会 [%s]\n", member.c_str(), g.name.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::transferLeadership(const std::string& leader, const std::string& target) {
  auto it = memberIndex_.find(leader);
  if (it == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = it->second;
  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  Guild& g = git->second;
  if (g.leaderUsername != leader) return GUILD_ERR_NO_PERM;

  GuildMember* m = findMember(guildId, target);
  if (!m) return GUILD_ERR_TARGET_NOT_IN;

  // 转让
  GuildMember* oldLeader = findMember(guildId, leader);
  if (oldLeader) oldLeader->role = GUILD_OFFICER;
  m->role = GUILD_LEADER;
  g.leaderUsername = target;

  fprintf(stderr, "[guild] %s 转让会长给 %s\n", leader.c_str(), target.c_str());
  return GUILD_OK;
}

GuildResult GuildSystem::editNotice(const std::string& officer, const std::string& notice) {
  auto it = memberIndex_.find(officer);
  if (it == memberIndex_.end()) return GUILD_ERR_NOT_IN;

  uint32_t guildId = it->second;
  if (!hasPermission(guildId, officer, GUILD_OFFICER)) return GUILD_ERR_NO_PERM;

  auto git = guilds_.find(guildId);
  if (git == guilds_.end()) return GUILD_ERR_NOT_FOUND;

  git->second.notice = notice;
  return GUILD_OK;
}

const Guild* GuildSystem::getGuild(uint32_t guildId) const {
  auto it = guilds_.find(guildId);
  return it == guilds_.end() ? nullptr : &it->second;
}

const Guild* GuildSystem::getPlayerGuild(const std::string& username) const {
  auto it = memberIndex_.find(username);
  if (it == memberIndex_.end()) return nullptr;
  return getGuild(it->second);
}

uint32_t GuildSystem::getPlayerGuildId(const std::string& username) const {
  auto it = memberIndex_.find(username);
  return it == memberIndex_.end() ? 0 : it->second;
}

std::vector<Guild> GuildSystem::searchGuilds(const std::string& keyword) const {
  std::vector<Guild> result;
  for (const auto& [id, g] : guilds_) {
    if (keyword.empty() || g.name.find(keyword) != std::string::npos) {
      result.push_back(g);
    }
  }
  return result;
}

bool GuildSystem::buildGuildInfo(uint32_t guildId, proto::GuildInfoData& out) const {
  auto it = guilds_.find(guildId);
  if (it == guilds_.end()) return false;

  const Guild& g = it->second;
  out.guildId = g.guildId;
  out.name = g.name;
  out.notice = g.notice;
  out.leaderUsername = g.leaderUsername;
  out.memberCount = g.memberCount;
  out.maxMembers = g.maxMembers;
  out.level = g.level;
  out.exp = g.exp;
  out.logo = g.logo;
  out.createdMs = g.createdMs;

  for (const auto& m : g.members) {
    proto::GuildMemberData md;
    md.username = m.username;
    md.role = (uint8_t)m.role;
    md.joinMs = m.joinMs;
    md.lastActiveMs = m.lastActiveMs;
    md.contributionPts = m.contributionPts;
    md.title = m.title;
    md.online = (world_.findPlayerByUsername(m.username) != nullptr);
    out.members.push_back(md);
  }
  return true;
}

void GuildSystem::updateMemberActivity(const std::string& username) {
  auto it = memberIndex_.find(username);
  if (it == memberIndex_.end()) return;

  GuildMember* m = findMember(it->second, username);
  if (m) m->lastActiveMs = steadyMs();
}

bool GuildSystem::hasPermission(uint32_t guildId, const std::string& username, GuildRole minRole) const {
  GuildRole role = getMemberRole(guildId, username);
  return role <= minRole; // 数值越小等级越高
}

GuildRole GuildSystem::getMemberRole(uint32_t guildId, const std::string& username) const {
  const GuildMember* m = findMember(guildId, username);
  return m ? m->role : GUILD_RECRUIT;
}

GuildMember* GuildSystem::findMember(uint32_t guildId, const std::string& username) {
  auto it = guilds_.find(guildId);
  if (it == guilds_.end()) return nullptr;
  for (auto& m : it->second.members) {
    if (m.username == username) return &m;
  }
  return nullptr;
}

const GuildMember* GuildSystem::findMember(uint32_t guildId, const std::string& username) const {
  auto it = guilds_.find(guildId);
  if (it == guilds_.end()) return nullptr;
  for (const auto& m : it->second.members) {
    if (m.username == username) return &m;
  }
  return nullptr;
}

} // namespace ew
