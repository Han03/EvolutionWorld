// base64.h
#pragma once
#include <string>

namespace ew {
std::string base64Encode(const unsigned char* data, size_t len);
std::string base64Decode(const std::string& in);
}
