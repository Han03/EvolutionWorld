// websocket.h - RFC6455 WebSocket 帧编解码（服务端侧）
#pragma once
#include <string>

namespace ew {

// 计算 Sec-WebSocket-Accept（SHA-1(key+GUID) 后 base64）
std::string wsAcceptKey(const std::string& key);

// 解码一帧（客户端→服务端，含掩码）；不足一帧返回 false
bool wsDecodeFrame(const std::string& in, size_t& consumed, bool& fin, int& opcode, std::string& payload);

// 编码一帧（服务端→客户端，不掩码）
std::string wsEncodeFrame(int opcode, const std::string& payload, bool fin = true);

// 常用 opcode
enum WsOpcode { WS_TEXT = 1, WS_BINARY = 2, WS_CLOSE = 8, WS_PING = 9, WS_PONG = 10 };

} // namespace ew
