// json.h - 极简 JSON 值/解析/序列化（自包含，无第三方依赖）
#pragma once
#include <string>
#include <vector>
#include <map>
#include <variant>
#include <cstdint>
#include <stdexcept>

namespace ew {

class Json {
public:
  using Object = std::map<std::string, Json>;
  using Array = std::vector<Json>;
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() : t_(Type::Null) {}
  Json(std::nullptr_t) : t_(Type::Null) {}
  Json(bool b) : t_(Type::Bool), v_(b) {}
  Json(int v) : t_(Type::Number), v_((int64_t)v) {}
  Json(int64_t v) : t_(Type::Number), v_(v) {}
  Json(double v) : t_(Type::Number), v_(v) {}
  Json(const char* s) : t_(Type::String), v_(std::string(s)) {}
  Json(const std::string& s) : t_(Type::String), v_(s) {}
  Json(const Array& a) : t_(Type::Array), v_(a) {}
  Json(const Object& o) : t_(Type::Object), v_(o) {}
  static Json array() { return Json(Type::Array); }
  static Json object() { return Json(Type::Object); }

  Type type() const { return t_; }
  bool isNull() const { return t_ == Type::Null; }

  bool asBool() const { return std::get<bool>(v_); }
  double asNumber() const {
    if (std::holds_alternative<double>(v_)) return std::get<double>(v_);
    if (std::holds_alternative<int64_t>(v_)) return (double)std::get<int64_t>(v_);
    return 0;
  }
  int64_t asInt() const {
    if (std::holds_alternative<int64_t>(v_)) return std::get<int64_t>(v_);
    if (std::holds_alternative<double>(v_)) return (int64_t)std::get<double>(v_);
    return 0;
  }
  const std::string& asString() const { return std::get<std::string>(v_); }
  Array& asArray() { return std::get<Array>(v_); }
  const Array& asArray() const { return std::get<Array>(v_); }
  Object& asObject() { return std::get<Object>(v_); }
  const Object& asObject() const { return std::get<Object>(v_); }

  bool has(const std::string& k) const {
    if (t_ != Type::Object) return false;
    return std::get<Object>(v_).count(k) > 0;
  }
  Json& operator[](const std::string& k) { return std::get<Object>(v_)[k]; }
  const Json& at(const std::string& k) const {
    static const Json null_;
    if (t_ != Type::Object) return null_;
    auto& o = std::get<Object>(v_);
    auto it = o.find(k);
    return it == o.end() ? null_ : it->second;
  }
  void push_back(const Json& v) { std::get<Array>(v_).push_back(v); }
  size_t size() const {
    if (t_ == Type::Array) return std::get<Array>(v_).size();
    if (t_ == Type::Object) return std::get<Object>(v_).size();
    return 0;
  }

  std::string dump() const;
  static Json parse(const std::string& s); // throws std::runtime_error

private:
  explicit Json(Type t) : t_(t) {
    if (t == Type::Array) v_ = Array();
    else if (t == Type::Object) v_ = Object();
  }
  Type t_;
  std::variant<std::monostate, bool, int64_t, double, std::string, Array, Object> v_;
};

} // namespace ew
