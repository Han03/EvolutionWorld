// skills.cpp - 技能定义工具 + 默认技能表 + JSON 覆盖
#include "skills.h"
#include "util/json.h"
#include <cstdio>
namespace ew {
const char* SkillDef::targetName(SkillTarget t) {
  switch (t) {
    case SkillTarget::SELF: return "自身";
    case SkillTarget::ENEMY: return "敌方";
    case SkillTarget::AOE: return "区域";
    default: return "未知";
  }
}
const char* SkillDef::effectName(SkillEffect e) {
  switch (e) {
    case SkillEffect::DAMAGE: return "伤害";
    case SkillEffect::HEAL: return "治疗";
    case SkillEffect::BUFF: return "增益";
    default: return "无";
  }
}
const char* SkillDef::buffName(BuffType b) {
  switch (b) {
    case BuffType::ATK: return "攻击提升";
    case BuffType::DEF: return "防御提升";
    case BuffType::MOVE_SLOW: return "减速";
    case BuffType::REGEN: return "持续回血";
    case BuffType::THORNS: return "荆棘反伤";
    default: return "无";
  }
}
SkillTarget SkillDef::targetFromStr(const std::string& s) {
  if (s == "self") return SkillTarget::SELF;
  if (s == "enemy") return SkillTarget::ENEMY;
  if (s == "aoe") return SkillTarget::AOE;
  return SkillTarget::SELF;
}
SkillEffect SkillDef::effectFromStr(const std::string& s) {
  if (s == "damage") return SkillEffect::DAMAGE;
  if (s == "heal") return SkillEffect::HEAL;
  if (s == "buff") return SkillEffect::BUFF;
  return SkillEffect::NONE;
}
BuffType SkillDef::buffFromStr(const std::string& s) {
  if (s == "atk") return BuffType::ATK;
  if (s == "def") return BuffType::DEF;
  if (s == "slow") return BuffType::MOVE_SLOW;
  if (s == "regen") return BuffType::REGEN;
  if (s == "thorns") return BuffType::THORNS;
  return BuffType::NONE;
}
} // namespace ew
