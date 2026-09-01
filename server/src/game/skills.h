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
// 大型网游化：**取消目标检测**，无目标也可施放。所有技能以「落点 (tx,tz) + 命中半径 radius」
// 计算是否击中；target 仅决定落点语义（SELF=自身位置 / 其余=客户端指定落点）。
enum class SkillTarget : uint8_t {
  SELF = 1,  // 自身为中心（治疗/增益/以自身为圆心的范围）
  ENEMY = 2, // 落点为中心（旧：单目标伤害/减益，现：落点 radius 命中）
  AOE = 3,   // 区域（以客户端落点为中心的范围伤害/减益）
};
// ---------- 技能效果 ----------
enum class SkillEffect : uint8_t {
  NONE = 0,
  DAMAGE = 1, // 伤害（范围命中，dmgMul×攻击 + flatDmg）
  HEAL = 2,   // 治疗（SELF）
  BUFF = 3,   // 挂载 Buff（增益/减益，按范围命中目标）
};
// ---------- Buff 类型（可叠加语义：同类型同技能刷新，不同类型并存） ----------
enum class BuffType : uint8_t {
  NONE = 0,
  ATK = 1,        // 攻击加成（平值，叠加到派生属性；负数=减攻）
  DEF = 2,        // 防御加成（平值；负数=减防）
  MOVE_SLOW = 3,  // 减速（0..1 比例，作用于移动速度）
  REGEN = 4,      // 持续回血（值 = 每秒回复量）
  THORNS = 5,     // 反伤（受到伤害时按比例反弹给攻击者）
  BLEED = 6,      // 流血（值 = 每秒损失生命，DoT）
  DEF_DOWN = 7,   // 减防（负平值，叠加到防御）
  ATK_DOWN = 8,   // 减攻（负平值，叠加到攻击）
  STUN = 9,       // 眩晕（无法移动/攻击；霸体可免疫）
  SUPER_ARMOR = 10, // 霸体（免疫眩晕/击退）
  SPEED = 11,     // 加速（正值比例，作用于移动速度）
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
  double knockback = 0;           // 击退距离（米）：命中时沿施法者→目标方向击退（霸体免疫）
  bool superArmor = false;        // 霸体：施放该技能期间自身免疫眩晕/击退
  uint16_t castTimeMs = 0;        // 施放时间/前摇（毫秒，0=瞬发）。前摇期间不生效，到期结算
  bool castCancelOnMove = true;   // 前摇期间移动是否打断（大型网游标配；false=不可打断技能）
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
