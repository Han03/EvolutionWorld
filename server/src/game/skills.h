// skills.h - 技能系统（大型网游规模，数据驱动）
//
// 设计要点：
//  - 技能定义 SkillDef 按 ID 管理：名称/描述/图标/目标类型/耗蓝/冷却/范围/AOE 半径/效果
//  - 效果类型：伤害（单目标/AOE）、治疗、Buff（增益/减益）
//  - 冷却服务端权威（skillId -> readyAtMs），客户端只展示
//  - Buff 系统：攻击/防御/移速/回血/反伤，随技能施放挂载，buffSystem 每 tick 衰减
//  - 数据驱动：内置默认技能 + 可选 JSON 覆盖（data/skills.json）
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
namespace ew {
// ---------- 技能目标类型 ----------
enum class SkillTarget : uint8_t {
  SELF = 1,  // 自身（治疗/增益）
  ENEMY = 2, // 敌方单位（单目标伤害/减益）
  AOE = 3,   // 区域（以 x/z 为中心的范围伤害/减益）
};
// ---------- 技能效果 ----------
enum class SkillEffect : uint8_t {
  NONE = 0,
  DAMAGE = 1, // 伤害（单目标 / AOE，dmgMul×攻击 + flatDmg）
  HEAL = 2,   // 治疗（SELF）
  BUFF = 3,   // 挂载 Buff（增益/减益）
};
// ---------- Buff 类型（可叠加语义：同类型同技能刷新，不同类型并存） ----------
enum class BuffType : uint8_t {
  NONE = 0,
  ATK = 1,       // 攻击加成（平值，叠加到派生属性）
  DEF = 2,       // 防御加成
  MOVE_SLOW = 3, // 减速（0..1 比例，作用于移动速度）
  REGEN = 4,     // 持续回血（值 = 每秒回复量）
  THORNS = 5,    // 反伤（受到伤害时按比例反弹给攻击者）
};
// ---------- 技能定义（按 ID 管理） ----------
struct SkillDef {
  uint32_t id = 0;
  std::string name;
  std::string desc;
  std::string icon;              // 客户端缩略图标识
  SkillTarget target = SkillTarget::SELF;
  SkillEffect effect = SkillEffect::NONE;
  double manaCost = 0;           // 耗蓝
  uint32_t cooldownMs = 0;       // 冷却（毫秒，服务端权威）
  double range = 0;              // 目标距离（ENEMY/AOE）
  double radius = 0;             // AOE 半径（0=单目标）
  double dmgMul = 1.0;           // 伤害系数（×攻击力）
  double flatDmg = 0;            // 额外固定伤害
  double heal = 0;               // 治疗量（HEAL）
  BuffType buffType = BuffType::NONE; // BUFF 效果
  double buffValue = 0;               // Buff 值（ATK/DEF 平值，MOVE_SLOW/THORNS 比例，REGEN 每秒回血量）
  double buffDurSec = 0;              // Buff 持续时长（秒）
  double lifesteal = 0;           // 吸血比例 0..1（DAMAGE 附加）
  uint16_t castTimeMs = 0;        // 施放时间/前摇（毫秒，0=瞬发）。前摇期间不生效，到期结算
  bool castCancelOnMove = true;   // 前摇期间移动是否打断（大型网游标配）
  bool castCancelOnHit = true;    // 前摇期间受击是否打断
  // 显示辅助
  static const char* targetName(SkillTarget t);
  static const char* effectName(SkillEffect e);
  static const char* buffName(BuffType b);
  static SkillTarget targetFromStr(const std::string& s);
  static SkillEffect effectFromStr(const std::string& s);
  static BuffType buffFromStr(const std::string& s);
};
} // namespace ew
