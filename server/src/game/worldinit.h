// worldinit.h - 世界初始化执行器（大型网游规模：数据驱动生成，代码不保存地形/生物布局）
//
// 职责（对应需求）：
//   1) 生成地形数据：可通行 mask（主城 + 主干道路网），BFS 裁剪保证「所有地区可到达」；
//      mask 只落在天然干地（非深水/非悬崖），确保生物投放不会落入空洞。
//   2) 生成主城区域：中心圆盘为出生/商店安全区，主城免怪半径内不投放怪物。
//   3) 自动投放生物：NPC 在主城内；怪物按「距主城越远实力越强」分档、相同怪物成群出现；
//      Boss 投放到远境。全部锚点取自 mask 可通行格 → 不进空洞。
//   4) 序列化：把 mask + 出生点打包为持久化 JSON（数据库模式），或从 JSON 还原（不刷生物）。
//
// 内存模式：每次服务端启动调用 generateWorld 重新生成；
// 数据库模式：优先 loadWorld 从库还原，失败再 generateWorld 并 saveWorld 落库。
#pragma once
#include <string>
#include <cstdint>
#include "spawns.h"

namespace ew {

class World;
struct Config;

// 生成世界数据：连通可通行 mask（安装到 terrain）+ 数据驱动生物投放（写入 world.spawns）。
// 仅生成数据，不刷出实体；调用方随后 seedWorld()/reseedCreatures() 依据出生点建实体。
bool generateWorld(World& w, const Config& cfg);

// 把当前 mask + 出生点打包为持久化 JSON（数据库模式保存用）
std::string worldDataToJson(const SpawnConfig& spawns);
// 从持久化 JSON 还原 mask（安装到 terrain）+ 出生点（写入 world.spawns），不刷实体
bool worldDataFromJson(World& w, const std::string& json);

// 当前可通行 mask 的 base64 编码（供 /api/terrain/mask 下发客户端）
std::string walkMaskToBase64();

} // namespace ew
