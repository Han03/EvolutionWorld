// base64.cpp
#include "base64.h"

namespace ew {

static const char* B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const unsigned char* data, size_t len) {
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  for (size_t i = 0; i < len; i += 3) {
    unsigned n = (unsigned)data[i] << 16;
    if (i + 1 < len) n |= (unsigned)data[i + 1] << 8;
    if (i + 2 < len) n |= (unsigned)data[i + 2];
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += (i + 1 < len) ? B64[(n >> 6) & 63] : '=';
    out += (i + 2 < len) ? B64[n & 63] : '=';
  }
  return out;
}

std::string base64Decode(const std::string& in) {
  int vals[256];
  for (int i = 0; i < 256; i++) vals[i] = -1;
  for (int i = 0; i < 64; i++) vals[(unsigned char)B64[i]] = i;
  std::string out;
  int buf = 0, bits = 0;
  for (unsigned char c : in) {
    if (c == '=' || c == '\n' || c == '\r') continue;
    int v = vals[c];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((buf >> bits) & 0xFF);
    }
  }
  return out;
}

} // namespace ew
