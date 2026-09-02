// http.cpp
#include "http.h"
#include <cctype>
#include <sstream>

namespace ew {

bool httpParseRequest(const std::string& buf, size_t& consumed, HttpRequest& req) {
  // 找头部结束
  size_t hEnd = buf.find("\r\n\r\n");
  if (hEnd == std::string::npos) return false; // 头部未完整
  consumed = hEnd + 4;

  size_t lineEnd = buf.find("\r\n");
  if (lineEnd == std::string::npos) return false;
  std::string reqLine = buf.substr(0, lineEnd);
  std::istringstream ls(reqLine);
  ls >> req.method >> req.path >> req.version;
  if (req.path.empty()) return false;

  // 拆分 path/query
  size_t q = req.path.find('?');
  if (q != std::string::npos) {
    req.query = req.path.substr(q + 1);
    req.path = req.path.substr(0, q);
  }

  // 头部行
  size_t pos = lineEnd + 2;
  while (pos < hEnd) {
    size_t eol = buf.find("\r\n", pos);
    if (eol == std::string::npos || eol > hEnd) break;
    std::string line = buf.substr(pos, eol - pos);
    size_t colon = line.find(':');
    if (colon != std::string::npos) {
      std::string k = line.substr(0, colon);
      std::string v = line.substr(colon + 1);
      // key 小写
      for (auto& c : k) c = (char)std::tolower((unsigned char)c);
      // 去首尾空白
      size_t b = v.find_first_not_of(" \t");
      size_t e = v.find_last_not_of(" \t");
      req.headers[k] = (b == std::string::npos) ? "" : v.substr(b, e - b + 1);
    }
    pos = eol + 2;
  }

  // body
  size_t contentLength = 0;
  auto it = req.headers.find("content-length");
  if (it != req.headers.end()) contentLength = (size_t)std::atoll(it->second.c_str());
  if (buf.size() >= consumed + contentLength) {
    req.body = buf.substr(consumed, contentLength);
    consumed += contentLength;
    req.valid = true;
    return true;
  }
  return false; // body 未完整
}

std::string httpBuildResponse(int code, const std::string& status,
                              const std::string& contentType, const std::string& body) {
  std::string res;
  res.reserve(256 + body.size());
  res += "HTTP/1.1 " + std::to_string(code) + " " + status + "\r\n";
  res += "Content-Type: " + contentType + "\r\n";
  res += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  res += "Connection: close\r\n";
  res += "Access-Control-Allow-Origin: *\r\n";
  res += "X-Content-Type-Options: nosniff\r\n";
  // HTML/JS/CSS 使用 no-cache（允许缓存但每次须重验证），避免 Edge 对 no-store 的 HTML 触发下载
  if (contentType.find("text/html") != std::string::npos ||
      contentType.find("javascript") != std::string::npos ||
      contentType.find("text/css") != std::string::npos) {
    res += "Cache-Control: no-cache\r\n";
  } else {
    res += "Cache-Control: no-store\r\n";
  }
  res += "\r\n";
  res += body;
  return res;
}

std::string httpBuildUpgrade(const std::string& acceptKey) {
  return "HTTP/1.1 101 Switching Protocols\r\n"
         "Upgrade: websocket\r\n"
         "Connection: Upgrade\r\n"
         "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
}

std::string urlDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      int h = hex(s[i + 1]), l = hex(s[i + 2]);
      if (h >= 0 && l >= 0) {
        out += (char)((h << 4) | l);
        i += 2;
        continue;
      }
    } else if (s[i] == '+') {
      out += ' ';
      continue;
    }
    out += s[i];
  }
  return out;
}

std::string queryParam(const std::string& query, const std::string& key) {
  size_t pos = 0;
  std::string target = key + "=";
  while (pos < query.size()) {
    size_t amp = query.find('&', pos);
    std::string seg = query.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
    if (seg.compare(0, target.size(), target) == 0) {
      return urlDecode(seg.substr(target.size()));
    }
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return "";
}

std::string mimeType(const std::string& path) {
  std::string ext;
  size_t dot = path.find_last_of('.');
  if (dot != std::string::npos) {
    ext = path.substr(dot);
    for (auto& c : ext) c = (char)std::tolower((unsigned char)c);
  }
  if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
  if (ext == ".css") return "text/css; charset=utf-8";
  if (ext == ".js" || ext == ".mjs") return "application/javascript; charset=utf-8";
  if (ext == ".json") return "application/json; charset=utf-8";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".svg") return "image/svg+xml";
  if (ext == ".ico") return "image/x-icon";
  if (ext == ".woff") return "font/woff";
  if (ext == ".woff2") return "font/woff2";
  if (ext == ".map") return "application/json";
  return "application/octet-stream";
}

} // namespace ew
