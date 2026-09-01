// json.cpp - 极简 JSON 解析/序列化实现
#include "json.h"
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <sstream>

namespace ew {

// ---------------- 序列化 ----------------
static void dumpValue(const Json& j, std::string& out) {
  switch (j.type()) {
    case Json::Type::Null: out += "null"; break;
    case Json::Type::Bool: out += j.asBool() ? "true" : "false"; break;
    case Json::Type::Number: {
      char buf[32];
      double d = j.asNumber();
      int64_t i = j.asInt();
      if ((double)i == d && std::fabs(d) < 9e15) snprintf(buf, sizeof(buf), "%lld", (long long)i);
      else snprintf(buf, sizeof(buf), "%.6g", d);
      out += buf;
      break;
    }
    case Json::Type::String: {
      out += '"';
      for (unsigned char c : j.asString()) {
        switch (c) {
          case '"': out += "\\\""; break;
          case '\\': out += "\\\\"; break;
          case '\n': out += "\\n"; break;
          case '\r': out += "\\r"; break;
          case '\t': out += "\\t"; break;
          default:
            if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
            else out += (char)c;
        }
      }
      out += '"';
      break;
    }
    case Json::Type::Array: {
      out += '[';
      bool first = true;
      for (const auto& e : j.asArray()) { if (!first) out += ','; first = false; dumpValue(e, out); }
      out += ']';
      break;
    }
    case Json::Type::Object: {
      out += '{';
      bool first = true;
      for (const auto& [k, v] : j.asObject()) {
        if (!first) out += ',';
        first = false;
        Json ks(k); dumpValue(ks, out); out += ':'; dumpValue(v, out);
      }
      out += '}';
      break;
    }
  }
}

std::string Json::dump() const {
  std::string out;
  dumpValue(*this, out);
  return out;
}

// ---------------- 解析 ----------------
namespace {

struct Parser {
  const char* p;
  const char* end;

  void skipWs() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; }

  bool fail(const char* msg) { throw std::runtime_error(std::string("json parse error: ") + msg); }

  std::string parseString() {
    if (p >= end || *p != '"') fail("expected string");
    p++;
    std::string s;
    while (p < end) {
      char c = *p++;
      if (c == '"') return s;
      if (c == '\\') {
        if (p >= end) break;
        char e = *p++;
        switch (e) {
          case '"': s += '"'; break;
          case '\\': s += '\\'; break;
          case '/': s += '/'; break;
          case 'n': s += '\n'; break;
          case 'r': s += '\r'; break;
          case 't': s += '\t'; break;
          case 'b': s += '\b'; break;
          case 'f': s += '\f'; break;
          case 'u': {
            if (p + 4 > end) fail("bad \\u");
            unsigned code = 0;
            for (int i = 0; i < 4; i++) {
              char h = *p++;
              code <<= 4;
              if (h >= '0' && h <= '9') code |= (h - '0');
              else if (h >= 'a' && h <= 'f') code |= (h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') code |= (h - 'A' + 10);
              else fail("bad \\u hex");
            }
            // 仅处理 BMP（代理对简单合并为两个 UTF-8 字节，足够本场景）
            if (code >= 0x80) {
              if (code >= 0x800) {
                s += (char)(0xE0 | (code >> 12));
                s += (char)(0x80 | ((code >> 6) & 0x3F));
                s += (char)(0x80 | (code & 0x3F));
              } else {
                s += (char)(0xC0 | (code >> 6));
                s += (char)(0x80 | (code & 0x3F));
              }
            } else {
              s += (char)code;
            }
            break;
          }
          default: s += e; break;
        }
      } else {
        s += c;
      }
    }
    fail("unterminated string");
    return s;
  }

  Json parseNumber() {
    const char* start = p;
    if (p < end && *p == '-') p++;
    while (p < end && (*p >= '0' && *p <= '9')) p++;
    bool isFloat = false;
    if (p < end && *p == '.') { isFloat = true; p++; while (p < end && (*p >= '0' && *p <= '9')) p++; }
    if (p < end && (*p == 'e' || *p == 'E')) {
      isFloat = true; p++;
      if (p < end && (*p == '+' || *p == '-')) p++;
      while (p < end && (*p >= '0' && *p <= '9')) p++;
    }
    std::string s(start, p);
    if (isFloat) return Json(strtod(s.c_str(), nullptr));
    return Json((int64_t)strtoll(s.c_str(), nullptr, 10));
  }

  Json parseValue() {
    skipWs();
    if (p >= end) fail("empty");
    char c = *p;
    if (c == '{') {
      p++;
      Json obj = Json::object();
      skipWs();
      if (p < end && *p == '}') { p++; return obj; }
      while (p < end) {
        skipWs();
        std::string key = parseString();
        skipWs();
        if (p >= end || *p != ':') fail("expected ':'");
        p++;
        obj[key] = parseValue();
        skipWs();
        if (p >= end) fail("unterminated object");
        if (*p == ',') { p++; continue; }
        if (*p == '}') { p++; return obj; }
        fail("expected ',' or '}'");
      }
      fail("unterminated object");
    } else if (c == '[') {
      p++;
      Json arr = Json::array();
      skipWs();
      if (p < end && *p == ']') { p++; return arr; }
      while (p < end) {
        arr.push_back(parseValue());
        skipWs();
        if (p >= end) fail("unterminated array");
        if (*p == ',') { p++; continue; }
        if (*p == ']') { p++; return arr; }
        fail("expected ',' or ']'");
      }
      fail("unterminated array");
    } else if (c == '"') {
      return Json(parseString());
    } else if (c == 't') { if (end - p >= 4 && memcmp(p, "true", 4) == 0) { p += 4; return Json(true); } fail("bad literal"); }
    else if (c == 'f') { if (end - p >= 5 && memcmp(p, "false", 5) == 0) { p += 5; return Json(false); } fail("bad literal"); }
    else if (c == 'n') { if (end - p >= 4 && memcmp(p, "null", 4) == 0) { p += 4; return Json(); } fail("bad literal"); }
    else if (c == '-' || (c >= '0' && c <= '9')) { return parseNumber(); }
    fail("unexpected char");
    return Json();
  }
};

} // namespace

Json Json::parse(const std::string& s) {
  Parser parser{s.data(), s.data() + s.size()};
  Json v = parser.parseValue();
  parser.skipWs();
  if (parser.p != parser.end) parser.fail("trailing data");
  return v;
}

} // namespace ew
