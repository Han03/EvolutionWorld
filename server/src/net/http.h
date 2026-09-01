// http.h - 极简 HTTP/1.1 解析与响应构造
#pragma once
#include <string>
#include <map>

namespace ew {

struct HttpRequest {
  std::string method;
  std::string path;      // 不含 query
  std::string query;     // ? 之后的原始字符串
  std::string version;
  std::map<std::string, std::string> headers; // key 小写
  std::string body;
  bool valid = false;
};

// 从缓冲区解析一个完整请求；成功返回 true 并设置 consumed（请求占用字节数）
bool httpParseRequest(const std::string& buf, size_t& consumed, HttpRequest& req);

std::string httpBuildResponse(int code, const std::string& status,
                              const std::string& contentType, const std::string& body);
// 101 升级响应（WebSocket）
std::string httpBuildUpgrade(const std::string& acceptKey);

// 小工具
std::string urlDecode(const std::string& s);
std::string queryParam(const std::string& query, const std::string& key);
std::string mimeType(const std::string& path);

} // namespace ew
