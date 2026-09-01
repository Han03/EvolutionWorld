#pragma once
#include <string>
#include <functional>
#include "world.h"

namespace ew {
// 控制台执行上下文：命令作用对象 + 输出回调
struct ConsoleCtx {
  World* world = nullptr;              // 世界管理器
  std::string playerId;                // 命令作用的玩家（空=仅全局命令可用）
  std::function<void(const std::string&)> out;  // 逐行输出回调（stdout / WS / HTTP 统一走这里）
};

// 执行一行控制台命令；返回 true=已识别并执行（含语法错误），false=未知命令
bool consoleExecute(ConsoleCtx& ctx, const std::string& line);
// 全部命令帮助文本（help）
std::string consoleHelpText();
} // namespace ew
