// console.cpp - 游戏控制台：测试命令集（供 stdout / WS / HTTP 多通道复用）
//
// 设计：命令解析与执行完全与传输通道解耦（ConsoleCtx.out 回调输出），
//       服务端 stdin 与网页控制台走同一套逻辑，保证测试行为一致。
// 命令面向"测试"，覆盖：实体/物品/金币/技能/属性/传送/Boss/掉落等全系统。
#include "console.h"
#include <cstdio>
#include <cstring>
#include <cmath>
#include <sstream>
#include <vector>
#include "skills.h"

namespace ew {

namespace {
// 简单字符串分割（保留空 token 便于参数计数）
std::vector<std::string> split(const std::string& s) {
  std::vector<std::string> out;
  std::istringstream ss(s);
  std::string tok;
  while (ss >> tok) out.push_back(tok);
  return out;
}
double toNum(const std::string& s, double dflt = 0) {
  if (s.empty()) return dflt;
  char* end = nullptr;
  double v = std::strtod(s.c_str(), &end);
  return (end && *end == '\0') ? v : dflt;
}
} // namespace

std::string consoleHelpText() {
  return
    "可用命令（控制台测试）：\n"
    "  help                         查看此帮助\n"
    "  echo <text>                  原样回显\n"
    "  status                       查看自身状态（位置/属性/技能/Buff）\n"
    "  players                      在线玩家列表\n"
    "  entities [range]             附近实体（默认 100m）\n"
    "  boss                         世界 Boss 状态\n"
    "  gold <n>                     给自身发放 n 金币\n"
    "  item <itemId> [count]        给自身发放物品\n"
    "  drop <itemId> [count]        在自身位置生成地面掉落物（drop gold <n> 发金币）\n"
    "  heal                         恢复满血满蓝\n"
    "  level <n>                    设置等级（重算基础属性）\n"
    "  stat <hp|mp|atk|def> <v>     设置基础属性\n"
    "  skill <skillId>              学习技能\n"
    "  skills                       查看已学技能与冷却\n"
    "  cast <skillId> [targetWid]   施放技能（无目标自动选最近怪物）\n"
    "  buff <atk|def|slow|regen|thorns> <value> <dur>   给自身挂 Buff\n"
    "  buff clear                   清除自身所有 Buff\n"
    "  spawn <type> [x z]           生成怪物（wolf/goblin/skeleton/gargoyle）\n"
    "  kill <wid|all|monsters|boss> 击杀实体/全部/普通怪/Boss\n"
    "  respawn [all|monsters|boss]  复活死亡实体\n"
    "  teleport <x> <z>             传送自身\n";
}

bool consoleExecute(ConsoleCtx& ctx, const std::string& line0) {
  if (!ctx.world) return false;
  std::string line = line0;
  // 去掉首尾空白
  size_t b = line.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return false;
  size_t e = line.find_last_not_of(" \t\r\n");
  line = line.substr(b, e - b + 1);
  auto args = split(line);
  if (args.empty()) return false;
  World& w = *ctx.world;
  const std::string& cmd = args[0];
  auto out = [&](const std::string& s) { if (ctx.out) ctx.out(s); };

  // ---- 通用/查看 ----
  if (cmd == "help") { out(consoleHelpText()); return true; }
  if (cmd == "echo") {
    std::string rest = args.size() > 1 ? line.substr(line.find(args[1])) : "";
    out(rest.empty() ? "" : rest);
    return true;
  }
  if (cmd == "players") {
    const auto& ps = w.players();
    std::ostringstream os;
    os << "在线玩家 " << ps.size() << " 人:";
    for (const auto& pid : ps) {
      Entity* p = w.findEntity(pid);
      if (p) os << " " << p->username << "(" << p->wid << ")@" << p->pos.x << "," << p->pos.z;
    }
    out(os.str());
    return true;
  }
  if (cmd == "entities") {
    Entity* p = w.findEntity(ctx.playerId);
    double range = args.size() > 1 ? toNum(args[1], 100) : 100;
    double px = p ? p->pos.x : 0, pz = p ? p->pos.z : 0;
    Json arr = w.entitiesStatus(px, pz, range, 50);
    std::ostringstream os;
    os << "附近实体 " << arr.size() << " 个:";
    for (const auto& j : arr.asArray()) {
      os << " [" << j.at("kind").asInt() << "]" << j.at("name").asString()
         << "(wid=" << j.at("wid").asInt() << ") hp=" << j.at("hp").asInt() << "/" << j.at("maxHp").asInt();
    }
    out(os.str());
    return true;
  }
  if (cmd == "boss") {
    Json arr = w.bossesStatus();
    for (const auto& j : arr.asArray()) {
      std::ostringstream os;
      os << "[Boss] " << j.at("name").asString() << " wid=" << j.at("wid").asInt()
         << " 状态=" << j.at("state").asInt() << " 阶段=" << j.at("phase").asInt()
         << " hp=" << j.at("hp").asInt() << "/" << j.at("maxHp").asInt()
         << " 激活=" << (j.at("active").asBool() ? "是" : "否")
         << " @" << j.at("x").asNumber() << "," << j.at("z").asNumber();
      out(os.str());
    }
    return true;
  }
  if (cmd == "status") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    std::ostringstream os;
    os << "玩家 " << p->username << " Lv." << p->level
       << " @(" << (int)p->pos.x << "," << (int)p->pos.z << ")"
       << " HP=" << (int)p->hp << "/" << (int)p->maxHp
       << " MP=" << (int)p->mp << "/" << (int)p->maxMp
       << " 攻=" << (int)p->attack << " 防=" << (int)p->defense
       << " 金币=" << p->pl.gold;
    out(os.str());
    std::ostringstream sk;
    sk << "已学技能:";
    for (uint32_t id : p->learnedSkills) {
      const SkillDef* sd = w.data().skill(id);
      sk << " " << (sd ? sd->name : std::to_string(id));
    }
    out(sk.str());
    std::ostringstream bf;
    bf << "Buff:";
    for (const auto& b : p->buffs)
      bf << " " << SkillDef::buffName((BuffType)b.type) << "=" << b.value << "(" << (int)b.remainSec << "s)";
    out(bf.str());
    return true;
  }

  // ---- 玩家资源/属性 ----
  if (cmd == "gold") {
    if (args.size() < 2) { out("用法: gold <n>"); return true; }
    int64_t n = (int64_t)toNum(args[1], 0);
    bool ok = w.giveGold(ctx.playerId, n);
    out(ok ? ("发放金币 " + std::to_string(n)) : "失败：无此玩家");
    return true;
  }
  if (cmd == "item") {
    if (args.size() < 2) { out("用法: item <itemId> [count]"); return true; }
    uint32_t id = (uint32_t)toNum(args[1], 0);
    uint16_t cnt = (uint16_t)(args.size() > 2 ? toNum(args[2], 1) : 1);
    const ItemDef* it = w.data().item(id);
    if (!it) { out("物品不存在: " + args[1]); return true; }
    bool ok = w.giveItem(ctx.playerId, id, cnt);
    out(ok ? ("发放物品 " + it->name + " x" + std::to_string(cnt)) : "失败：无此玩家");
    return true;
  }
  if (cmd == "drop") {
    if (args.size() < 2) { out("用法: drop <itemId|gold> [count]"); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    if (args[1] == "gold") {
      uint32_t g = (uint32_t)(args.size() > 2 ? toNum(args[2], 1) : 1);
      w.spawnDropAt(p->pos.x, p->pos.z, 0, g);
      out("生成金币掉落 x" + std::to_string(g));
      return true;
    }
    uint32_t id = (uint32_t)toNum(args[1], 0);
    const ItemDef* it = w.data().item(id);
    if (!it) { out("物品不存在: " + args[1]); return true; }
    uint32_t cnt = (uint32_t)(args.size() > 2 ? toNum(args[2], 1) : 1);
    for (uint32_t i = 0; i < cnt; i++) w.spawnDropAt(p->pos.x, p->pos.z, id, 0);
    out("生成物品掉落 " + it->name + " x" + std::to_string(cnt));
    return true;
  }
  if (cmd == "heal") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    p->hp = p->maxHp;
    p->mp = p->maxMp;
    w.markStatsDirty(ctx.playerId);
    out("已恢复满血满蓝");
    return true;
  }
  if (cmd == "level") {
    if (args.size() < 2) { out("用法: level <n>"); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    int lv = (int)toNum(args[1], 1);
    if (lv < 1) lv = 1;
    p->level = lv;
    p->pl.baseHp = 100 + (lv - 1) * 20.0;
    p->pl.baseMp = 50 + (lv - 1) * 10.0;
    p->pl.baseAttack = 12 + (lv - 1) * 3.0;
    p->pl.baseDefense = 3 + (lv - 1) * 1.0;
    w.recomputeStats(*p);
    w.markStatsDirty(ctx.playerId);
    out("等级设为 " + std::to_string(lv) + "，属性已重算");
    return true;
  }
  if (cmd == "stat") {
    if (args.size() < 3) { out("用法: stat <hp|mp|atk|def> <v>"); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    double v = toNum(args[2], 0);
    const std::string& k = args[1];
    if (k == "hp") p->pl.baseHp = v;
    else if (k == "mp") p->pl.baseMp = v;
    else if (k == "atk") p->pl.baseAttack = v;
    else if (k == "def") p->pl.baseDefense = v;
    else { out("未知属性: " + k); return true; }
    w.recomputeStats(*p);
    w.markStatsDirty(ctx.playerId);
    out("基础" + k + " 设为 " + std::to_string(v));
    return true;
  }

  // ---- 技能 ----
  if (cmd == "skill") {
    if (args.size() < 2) { out("用法: skill <skillId>"); return true; }
    uint32_t id = (uint32_t)toNum(args[1], 0);
    const SkillDef* sd = w.data().skill(id);
    if (!sd) { out("技能不存在: " + args[1]); return true; }
    bool ok = w.learnSkill(ctx.playerId, id);
    out(ok ? ("已学习技能 " + sd->name) : "失败：无此玩家");
    return true;
  }
  if (cmd == "skills") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    uint64_t nowMs = w.tickCount() * (uint64_t)w.config().tickMs;
    std::ostringstream os;
    os << "已学技能 " << p->learnedSkills.size() << " 个:";
    for (uint32_t id : p->learnedSkills) {
      const SkillDef* sd = w.data().skill(id);
      if (!sd) continue;
      uint64_t left = 0;
      auto it = p->skillCd.find(id);
      if (it != p->skillCd.end() && it->second > nowMs) left = it->second - nowMs;
      os << " " << sd->name << "(cd=" << left / 1000.0 << "s)";
    }
    out(os.str());
    return true;
  }
  if (cmd == "cast") {
    if (args.size() < 2) { out("用法: cast <skillId> [targetWid]"); return true; }
    uint32_t id = (uint32_t)toNum(args[1], 0);
    const SkillDef* sd = w.data().skill(id);
    if (!sd) { out("技能不存在: " + args[1]); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    uint32_t twid = args.size() > 2 ? (uint32_t)toNum(args[2], 0) : 0;
    double tx = p->pos.x, tz = p->pos.z;
    if (sd->target == SkillTarget::ENEMY && twid == 0) {
      // 自动选最近怪物
      Entity* best = nullptr; double bd = 1e18;
      for (auto& [id2, e] : w.entities()) {
        if (!e.active || e.kind != EntityKind::Monster) continue;
        double d = e.pos.dist2D(p->pos);
        if (d < bd) { bd = d; best = const_cast<Entity*>(&e); }
      }
      if (best) twid = best->wid;
      else { out("附近没有怪物可施放单目标技能"); return true; }
    }
    bool ok = w.beginCast(ctx.playerId, id, twid, tx, tz);
    out(ok ? ("施放技能 " + sd->name) : ("施放失败（未学习/冷却/蓝不足/距离）"));
    return true;
  }
  if (cmd == "buff") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    if (args.size() >= 2 && args[1] == "clear") {
      p->buffs.clear();
      w.recomputeStats(*p);
      w.markBuffsDirty(ctx.playerId);
      w.markStatsDirty(ctx.playerId);
      out("已清除所有 Buff");
      return true;
    }
    if (args.size() < 4) { out("用法: buff <atk|def|slow|regen|thorns> <value> <dur>"); return true; }
    uint8_t type = 0;
    const std::string& k = args[1];
    if (k == "atk") type = (uint8_t)BuffType::ATK;
    else if (k == "def") type = (uint8_t)BuffType::DEF;
    else if (k == "slow") type = (uint8_t)BuffType::MOVE_SLOW;
    else if (k == "regen") type = (uint8_t)BuffType::REGEN;
    else if (k == "thorns") type = (uint8_t)BuffType::THORNS;
    else { out("未知 Buff 类型: " + k); return true; }
    double v = toNum(args[2], 0), dur = toNum(args[3], 0);
    w.applyBuff(*p, 0, type, v, dur);
    out("挂载 Buff " + std::string(SkillDef::buffName((BuffType)type)) + "=" + args[2] + " " + args[3] + "s");
    return true;
  }

  // ---- 实体 ----
  if (cmd == "spawn") {
    if (args.size() < 2) { out("用法: spawn <type> [x z]"); return true; }
    const std::string& type = args[1];
    Entity* p = w.findEntity(ctx.playerId);
    double x = p ? p->pos.x : 0, z = p ? p->pos.z : 0;
    if (args.size() >= 4) { x = toNum(args[2], x); z = toNum(args[3], z); }
    Entity* m = w.spawnMonster(type, x, z);
    out(m ? ("生成怪物 " + m->name + " wid=" + std::to_string(m->wid) + " @" + std::to_string((int)m->pos.x) + "," + std::to_string((int)m->pos.z))
          : "怪物类型不存在: " + type);
    return true;
  }
  if (cmd == "kill") {
    if (args.size() < 2) { out("用法: kill <wid|all|monsters|boss>"); return true; }
    const std::string& t = args[1];
    int killed = 0;
    if (t == "all" || t == "monsters" || t == "boss") {
      std::vector<uint32_t> wids;
      for (const auto& [id, e] : w.entities()) {
        if (e.kind != EntityKind::Monster || !e.active) continue;
        if (t == "boss" && !e.isBoss) continue;
        if (t == "monsters" && e.isBoss) continue;
        wids.push_back(e.wid);
      }
      for (uint32_t wid : wids) if (w.killEntity(ctx.playerId, wid)) killed++;
    } else {
      uint32_t wid = (uint32_t)toNum(args[1], 0);
      killed = w.killEntity(ctx.playerId, wid) ? 1 : 0;
    }
    out("击杀 " + std::to_string(killed) + " 个实体");
    return true;
  }
  if (cmd == "respawn") {
    std::string t = args.size() > 1 ? args[1] : "all";
    int n = 0;
    if (t == "boss") {
      for (auto& [id, e] : w.entitiesMut()) {
        if (e.isBoss) { if (w.respawnEntity(id)) n++; }
      }
    } else if (t == "monsters") {
      for (auto& [id, e] : w.entitiesMut()) {
        if (e.kind == EntityKind::Monster && !e.isBoss) { if (w.respawnEntity(id)) n++; }
      }
    } else {
      for (auto& [id, e] : w.entitiesMut()) {
        if (e.kind == EntityKind::Monster) { if (w.respawnEntity(id)) n++; }
      }
    }
    out("复活 " + std::to_string(n) + " 个实体");
    return true;
  }
  if (cmd == "teleport") {
    if (args.size() < 3) { out("用法: teleport <x> <z>"); return true; }
    double x = toNum(args[1], 0), z = toNum(args[2], 0);
    bool ok = w.teleportPlayer(ctx.playerId, x, z);
    out(ok ? ("传送至 " + args[1] + "," + args[2]) : "失败：无此玩家");
    return true;
  }

  return false; // 未知命令
}
} // namespace ew
