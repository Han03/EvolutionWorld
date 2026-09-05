// console.cpp - 游戏控制台：测试命令集（供 stdout / WS / HTTP 多通道复用）
//
// 设计：命令解析与执行完全与传输通道解耦（ConsoleCtx.out 回调输出），
//       服务端 stdin 与网页控制台走同一套逻辑，保证测试行为一致。
// 命令面向“测试”，覆盖：实体/物品/金币/技能/属性/传送/精英/掉落等全系统。
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
    "  elite                        世界精英状态\n"
    "  gold <n>                     给自身发放 n 金币\n"
    "  item <itemId> [count]        给自身发放物品\n"
    "  drop <itemId|gold> [count]   在自身位置生成地面掉落物（drop gold <n> 发金币）\n"
    "  heal                         恢复满血满蓝\n"
    "  shoprefresh                  重置当前玩家商店限购计数\n"
    "  level <n>                    设置等级（重算基础属性）\n"
    "  stat <hp|mp|atk|def> <v>     设置基础属性（上限）\n"
    "  sethp <v> / setmp <v>        设置当前 HP/MP（确定性压血/压蓝，测试用）\n"
    "  monsterpause <on|off>        全局冻结怪物/精英 AI+移动+施放（站桩测试）\n"
    "  freecast <on|off>            技能/普攻无蓝耗无冷却（重复测试同一技能）\n"
    "  anticheat <on|off>           开关防作弊校验（off=输入直接接受，测位移/瞬移）\n"
    "  enhanceforce <off|success|fail>  强化结果旁路（跳过 RNG，测升级/降级/保护符）\n"
    "  lockitem <instId> <0|1>      锁定/解锁装备实例（测「锁定不可分解」）\n"
    "  setenhance <instId> <lv>     直接设置装备强化等级（测「仓库存取保留强化」）\n"
    "  skill <skillId>              学习技能\n"
    "  skills                       查看已学技能与冷却\n"
    "  cast <skillId> [targetWid]   施放技能（无目标自动选最近怪物）\n"
    "  cdreset                      重置自身全部技能冷却\n"
    "  buff <atk|def|slow|regen|thorns|bleed|def_down|atk_down|stun|super_armor|speed> <value> <dur>   给自身挂 Buff\n"
    "  buff clear                   清除自身所有 Buff\n"
    "  buffmon <wid> <type> <v> <d> 给指定实体挂 Buff（调试/测试）\n"
    "  spawn <type> [x z]           生成怪物（wolf/goblin/skeleton/gargoyle）\n"
    "  kill <wid|all|monsters|elite> 击杀实体/全部/普通怪/精英\n"
    "  respawn [all|monsters|elite]  复活死亡实体\n"
    "  teleport <x> <z>             传送自身\n"
    "  quest list                   查看可接任务\n"
    "  quest active                 查看当前活跃任务\n"
    "  quest accept <questId>       接受任务\n"
    "  quest abandon <questId>      放弃任务\n"
    "  quest turnin <questId>       提交任务\n"
    "  quest progress <questId>     查看任务目标进度\n"
    "  quest complete <questId>     强制完成（测试）\n"
    "  quest reset [daily]          重置日常冷却 / 全部任务\n";
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
    Json arr = w.entitiesStatus(px, pz, range, 300);
    std::ostringstream os;
    os << "附近实体 " << arr.size() << " 个:";
    for (const auto& j : arr.asArray()) {
      os << " [" << j.at("kind").asInt() << "]" << j.at("name").asString()
         << "(wid=" << j.at("wid").asInt() << ") hp=" << j.at("hp").asInt() << "/" << j.at("maxHp").asInt();
      if (j.has("atk")) os << " atk=" << j.at("atk").asInt() << " def=" << j.at("def").asInt();
      os << " @(" << j.at("x").asNumber() << "," << j.at("z").asNumber() << ")";
    }
    out(os.str());
    return true;
  }
  if (cmd == "elite") {
    Json arr = w.elitesStatus();
    for (const auto& j : arr.asArray()) {
      std::ostringstream os;
      os << "[精英] " << j.at("name").asString() << " wid=" << j.at("wid").asInt()
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
  // 强制刷新商店限购（阶段1测试用：模拟每日/每周刷新，重置当前玩家限购计数）
  if (cmd == "shoprefresh") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    p->pl.shopBuyCount.clear();
    p->pl.shopRefreshMs = w.logicNowMs();
    out("已重置商店限购计数");
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
  // 设置自身当前 HP/MP（确定性压血/压蓝，用于恢复类/耗蓝类测试）
  // 注：区别于 stat（改基础值→上限），sethp/setmp 改的是当前值；sethp 最低 1（测死亡用 kill）
  if (cmd == "sethp" || cmd == "setmp") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    if (args.size() < 2) { out("用法: " + cmd + " <value>"); return true; }
    double v = toNum(args[1], 0);
    if (cmd == "sethp") {
      double mx = p->maxHp;
      if (v < 1.0) v = 1.0;
      if (v > mx) v = mx;
      p->hp = v;
      out("当前 HP 设为 " + std::to_string((int)p->hp) + "/" + std::to_string((int)mx));
    } else {
      double mx = p->maxMp;
      if (v < 0.0) v = 0.0;
      if (v > mx) v = mx;
      p->mp = v;
      out("当前 MP 设为 " + std::to_string((int)p->mp) + "/" + std::to_string((int)mx));
    }
    w.markStatsDirty(ctx.playerId);
    return true;
  }

  // ---- 测试控制：全局开关（大型网游常用测试命令；影响世界内所有玩家/怪物，默认关闭=正常玩法）----
  // 典型技能伤害测试流程：anticheat off → monsterpause on → teleport 到位 → cast/attack → 检查；
  //                        需重复施放时 freecast on（无蓝耗/无冷却）。测试结束请复位（xxx on/off）。
  if (cmd == "monsterpause" || cmd == "freecast") {
    bool& flag = (cmd == "monsterpause") ? w.testFlags().monstersPaused : w.testFlags().noSkillCost;
    if (args.size() >= 2) {
      const std::string& a = args[1];
      if (a == "on" || a == "1" || a == "true") flag = true;
      else if (a == "off" || a == "0" || a == "false") flag = false;
      else { out("用法: " + cmd + " <on|off>"); return true; }
    } else {
      flag = !flag;
    }
    if (cmd == "monsterpause") out(std::string("怪物冻结(monsterpause)=") + (flag ? "on" : "off"));
    else out(std::string("无消耗施放(freecast)=") + (flag ? "on" : "off"));
    return true;
  }
  if (cmd == "anticheat") {
    // anticheat on=开启防作弊(正常)；off=关闭校验(测试) → 映射到 antiCheatBypass(取反)
    bool& bypass = w.testFlags().antiCheatBypass;
    if (args.size() >= 2) {
      const std::string& a = args[1];
      if (a == "on" || a == "1" || a == "true") bypass = false;
      else if (a == "off" || a == "0" || a == "false") bypass = true;
      else { out("用法: anticheat <on|off>"); return true; }
    } else {
      bypass = !bypass;
    }
    out(std::string("防作弊(anticheat)=") + (bypass ? "off(已关闭校验)" : "on(正常)"));
    return true;
  }
  // 强化结果旁路（阶段2测试用：跳过 RNG，强制成功/失败，验证升级/降级/保护符逻辑）
  if (cmd == "enhanceforce") {
    int& ef = w.testFlags().enhanceForce;
    if (args.size() >= 2) {
      const std::string& a = args[1];
      if (a == "off" || a == "0" || a == "normal") ef = 0;
      else if (a == "success" || a == "1" || a == "win") ef = 1;
      else if (a == "fail" || a == "2" || a == "lose") ef = 2;
      else { out("用法: enhanceforce <off|success|fail>"); return true; }
    }
    out(std::string("强化旁路(enhanceForce)=") + std::to_string(ef) +
        (ef == 0 ? "(正常RNG)" : ef == 1 ? "(强制成功)" : "(强制失败)"));
    return true;
  }
  // 锁定/解锁装备实例（阶段3测试用：验证「锁定装备不可分解」）
  if (cmd == "lockitem") {
    if (args.size() < 3) { out("用法: lockitem <instId> <0|1>"); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    uint64_t instId = (uint64_t)toNum(args[1], 0);
    bool lock = (toNum(args[2], 0) != 0);
    ItemInstance* ins = w.findInstance(*p, instId);
    if (!ins) { out("未找到装备实例: " + args[1]); return true; }
    ins->locked = lock;
    w.markInvDirty(ctx.playerId);
    out(std::string("装备实例 ") + args[1] + (lock ? " 已锁定" : " 已解锁"));
    return true;
  }
  // 直接设置装备实例强化等级（阶段5测试用：验证「存取出保留强化等级」，免去强化流程序）
  if (cmd == "setenhance") {
    if (args.size() < 3) { out("用法: setenhance <instId> <level>"); return true; }
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    uint64_t instId = (uint64_t)toNum(args[1], 0);
    int lv = (int)toNum(args[2], 0);
    if (lv < 0) lv = 0;
    if (lv > 15) lv = 15;
    ItemInstance* ins = w.findInstance(*p, instId);
    if (!ins) { out("未找到装备实例: " + args[1]); return true; }
    ins->enhance = (uint8_t)lv;
    w.markInvDirty(ctx.playerId);
    w.markStatsDirty(ctx.playerId);
    out("装备实例 " + args[1] + " 强化等级设为 +" + std::to_string(lv));
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
    uint64_t nowMs = w.logicNowMs();
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
    if (args.size() < 4) { out("用法: buff <atk|def|slow|regen|thorns|bleed|def_down|atk_down|stun|super_armor|speed> <value> <dur>"); return true; }
    uint8_t type = (uint8_t)SkillDef::buffFromStr(args[1]);
    if (type == (uint8_t)BuffType::NONE) { out("未知 Buff 类型: " + args[1]); return true; }
    double v = toNum(args[2], 0), dur = toNum(args[3], 0);
    w.applyBuff(*p, 0, type, v, dur);
    out("挂载 Buff " + std::string(SkillDef::buffName((BuffType)type)) + "=" + args[2] + " " + args[3] + "s");
    return true;
  }

  // 重置全部技能冷却（测试辅助）
  if (cmd == "cdreset") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    p->skillCd.clear();
    out("已重置全部技能冷却");
    return true;
  }
  // 恢复自身 HP/MP（测试辅助）
  if (cmd == "heal") {
    Entity* p = w.findEntity(ctx.playerId);
    if (!p) { out("未找到目标玩家"); return true; }
    p->hp = p->maxHp;
    p->mp = p->maxMp;
    w.markStatsDirty(ctx.playerId);
    out("已恢复 HP/MP 至满");
    return true;
  }
  // 给指定实体挂 Buff（测试/调试：验证怪物侧 debuff）
  if (cmd == "buffmon") {
    if (args.size() < 5) { out("用法: buffmon <wid> <type> <value> <dur>"); return true; }
    uint32_t wid = (uint32_t)toNum(args[1], 0);
    Entity* t = w.findByWid(wid);
    if (!t) { out("未找到实体 wid=" + args[1]); return true; }
    uint8_t type = (uint8_t)SkillDef::buffFromStr(args[2]);
    if (type == (uint8_t)BuffType::NONE) { out("未知 Buff 类型: " + args[2]); return true; }
    double v = toNum(args[3], 0), dur = toNum(args[4], 0);
    w.applyBuff(*t, 0, type, v, dur);
    out("给实体(wid=" + args[1] + ")挂载 " + std::string(SkillDef::buffName((BuffType)type)) + "=" + args[3] + " " + args[4] + "s");
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
    if (args.size() < 2) { out("用法: kill <wid|all|monsters|elite>"); return true; }
    const std::string& t = args[1];
    int killed = 0;
    if (t == "all" || t == "monsters" || t == "elite") {
      std::vector<uint32_t> wids;
      for (const auto& [id, e] : w.entities()) {
        if (e.kind != EntityKind::Monster || !e.active) continue;
        if (t == "elite" && !e.isElite) continue;
        if (t == "monsters" && e.isElite) continue;
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
    if (t == "elite") {
      for (auto& [id, e] : w.entitiesMut()) {
        if (e.isElite) { if (w.respawnEntity(id)) n++; }
      }
    } else if (t == "monsters") {
      for (auto& [id, e] : w.entitiesMut()) {
        if (e.kind == EntityKind::Monster && !e.isElite) { if (w.respawnEntity(id)) n++; }
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
  // ---- 任务系统 ----
  if (cmd == "quest") {
    Entity* p = ctx.playerId.empty() ? nullptr : w.findEntity(ctx.playerId);
    if (!p) { out("需要在线玩家"); return true; }
    std::string sub = args.size() > 1 ? args[1] : "";
    if (sub == "list") {
      auto avail = w.quests().availableQuests(*p);
      if (avail.empty()) { out("当前无可接任务"); }
      else {
        for (const QuestDef* qd : avail) {
          char buf[256];
          snprintf(buf, sizeof(buf), "  [%u] %s (%s) Lv%d - %s",
                   qd->id, qd->name.c_str(), QuestDef::categoryName(qd->category),
                   qd->levelReq, qd->desc.c_str());
          out(buf);
        }
      }
      return true;
    }
    if (sub == "active") {
      if (p->activeQuests.empty()) { out("当前无活跃任务"); }
      else {
        for (const auto& aq : p->activeQuests) {
          const QuestDef* qd = w.quests().questDef(aq.questId);
          if (!qd) continue;
          char buf[256];
          snprintf(buf, sizeof(buf), "  [%u] %s - %s",
                   aq.questId, qd->name.c_str(),
                   aq.status == 1 ? "可提交" : "进行中");
          out(buf);
          for (size_t i = 0; i < qd->objectives.size(); i++) {
            uint32_t cur = i < aq.progress.size() ? aq.progress[i] : 0;
            snprintf(buf, sizeof(buf), "    %s %u/%u",
                     qd->objectives[i].desc.c_str(), cur, qd->objectives[i].required);
            out(buf);
          }
        }
      }
      return true;
    }
    if (sub == "accept" && args.size() > 2) {
      uint32_t qid = (uint32_t)toNum(args[2], 0);
      auto result = w.quests().acceptQuest(p->id, qid);
      out(result == QUEST_OK ? "接受成功" : ("失败 code=" + std::to_string(result)));
      return true;
    }
    if (sub == "abandon" && args.size() > 2) {
      uint32_t qid = (uint32_t)toNum(args[2], 0);
      auto result = w.quests().abandonQuest(p->id, qid);
      out(result == QUEST_OK ? "放弃成功" : ("失败 code=" + std::to_string(result)));
      return true;
    }
    if (sub == "turnin" && args.size() > 2) {
      uint32_t qid = (uint32_t)toNum(args[2], 0);
      auto result = w.quests().turnInQuest(p->id, qid, 0);
      out(result == QUEST_OK ? "提交成功" : ("失败 code=" + std::to_string(result)));
      return true;
    }
    if (sub == "progress" && args.size() > 2) {
      uint32_t qid = (uint32_t)toNum(args[2], 0);
      const ActiveQuest* aq = w.quests().findActiveQuest(*p, qid);
      if (!aq) { out("任务不在进行中"); return true; }
      const QuestDef* qd = w.quests().questDef(qid);
      if (!qd) { out("任务不存在"); return true; }
      for (size_t i = 0; i < qd->objectives.size(); i++) {
        uint32_t cur = i < aq->progress.size() ? aq->progress[i] : 0;
        char buf[256];
        snprintf(buf, sizeof(buf), "  [%u] %s: %u/%u %s",
                 qid, qd->objectives[i].desc.c_str(), cur,
                 qd->objectives[i].required,
                 cur >= qd->objectives[i].required ? "✓" : "");
        out(buf);
      }
      return true;
    }
    if (sub == "complete" && args.size() > 2) {
      uint32_t qid = (uint32_t)toNum(args[2], 0);
      // 强制将所有目标进度设为完成
      for (auto& aq : p->activeQuests) {
        if (aq.questId == qid) {
          const QuestDef* qd = w.quests().questDef(qid);
          if (!qd) break;
          for (size_t i = 0; i < qd->objectives.size(); i++)
            aq.progress[i] = qd->objectives[i].required;
          aq.status = 1;
          w.markQuestDirty(p->id);
          out("强制完成目标");
          return true;
        }
      }
      out("任务不在进行中");
      return true;
    }
    if (sub == "reset") {
      std::string mode = args.size() > 2 ? args[2] : "all";
      if (mode == "daily") {
        p->questCooldown.clear();
        out("日常冷却已重置");
      } else {
        p->activeQuests.clear();
        p->completedQuests.clear();
        p->questCooldown.clear();
        w.markQuestDirty(p->id);
        out("全部任务已重置");
      }
      return true;
    }
    out("用法: quest list|active|accept|abandon|turnin|progress|complete|reset");
    return true;
  }

  return false; // 未知命令
}
} // namespace ew
