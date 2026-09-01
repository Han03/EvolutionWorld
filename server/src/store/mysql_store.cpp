// mysql_store.cpp - MySQL 存储后端实现（libmysqlclient C API + 预处理语句防注入）
#include "mysql_store.h"
#include <cstdio>
#include <cstring>
#ifdef EW_HAVE_MYSQL
#include <mysql/mysql.h>
#endif

namespace ew {

#ifdef EW_HAVE_MYSQL
// ---------------- 有 MySQL 头文件：真实后端 ----------------
struct MysqlImpl {
  MYSQL* conn = nullptr;
  bool up = false;
  ~MysqlImpl() { if (conn) mysql_close(conn); }
};

MysqlStore::MysqlStore(const StoreConfig& sc) : sc_(sc), impl_(new MysqlImpl()) {}
MysqlStore::~MysqlStore() = default;

bool MysqlStore::init() {
  if (!impl_) return false;
  MysqlImpl& m = *impl_;
  m.conn = mysql_init(nullptr);
  if (!m.conn) return false;
  // 设置连接超时
  unsigned timeout = 2;
  mysql_options(m.conn, MYSQL_OPT_CONNECT_TIMEOUT, &timeout);
  mysql_options(m.conn, MYSQL_OPT_READ_TIMEOUT, &timeout);
  if (!mysql_real_connect(m.conn, sc_.mysqlHost.c_str(), sc_.mysqlUser.c_str(),
                          sc_.mysqlPass.c_str(), sc_.mysqlDb.c_str(),
                          (unsigned)sc_.mysqlPort, nullptr, 0)) {
    fprintf(stderr, "[store] MySQL 连接失败(%s:%d): %s —— 降级到内存存储\n",
            sc_.mysqlHost.c_str(), sc_.mysqlPort,
            mysql_error(m.conn) ? mysql_error(m.conn) : "unknown");
    mysql_close(m.conn);
    m.conn = nullptr;
    return false;
  }
  // 建表（幂等）
  const char* kTables =
      "CREATE TABLE IF NOT EXISTS accounts ("
      " username VARCHAR(64) PRIMARY KEY,"
      " salt VARCHAR(64) NOT NULL,"
      " password_hash VARCHAR(128) NOT NULL,"
      " created_at VARCHAR(64) NOT NULL DEFAULT 'now'"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS player_saves ("
      " username VARCHAR(64) PRIMARY KEY,"
      " x DOUBLE NOT NULL DEFAULT 0,"
      " y DOUBLE NOT NULL DEFAULT 0,"
      " z DOUBLE NOT NULL DEFAULT 0,"
      " hp DOUBLE NOT NULL DEFAULT 100,"
      " level INT NOT NULL DEFAULT 1,"
      " updated_at BIGINT NOT NULL DEFAULT 0,"
      " gold INT NOT NULL DEFAULT 0,"
      " equip_json TEXT,"
      " inventory_json TEXT"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;";
  if (mysql_query(m.conn, kTables) != 0) {
    fprintf(stderr, "[store] MySQL 建表失败: %s —— 降级到内存存储\n", mysql_error(m.conn));
    mysql_close(m.conn);
    m.conn = nullptr;
    return false;
  }
  m.up = true;
  fprintf(stderr, "[store] MySQL 已连接 %s@%s:%d db=%s\n",
          sc_.mysqlUser.c_str(), sc_.mysqlHost.c_str(), sc_.mysqlPort, sc_.mysqlDb.c_str());
  return true;
}
bool MysqlStore::available() const {
  if (!impl_ || !impl_->conn || !impl_->up) return false;
  return mysql_ping(impl_->conn) == 0; // 断线检测
}
bool MysqlStore::upsertUser(const UserRecord& u) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO accounts(username,salt,password_hash,created_at) VALUES(?,?,?,?) "
                    "ON DUPLICATE KEY UPDATE salt=VALUES(salt),password_hash=VALUES(password_hash)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[4];
    memset(b, 0, sizeof(b));
    unsigned long usLen = u.username.size(), sLen = u.salt.size(), hLen = u.hash.size(), cLen = u.createdAt.size();
    b[0].buffer_type = MYSQL_TYPE_STRING; b[0].buffer = (void*)u.username.data(); b[0].buffer_length = (unsigned long)u.username.size(); b[0].length = &usLen;
    b[1].buffer_type = MYSQL_TYPE_STRING; b[1].buffer = (void*)u.salt.data(); b[1].buffer_length = (unsigned long)u.salt.size(); b[1].length = &sLen;
    b[2].buffer_type = MYSQL_TYPE_STRING; b[2].buffer = (void*)u.hash.data(); b[2].buffer_length = (unsigned long)u.hash.size(); b[2].length = &hLen;
    b[3].buffer_type = MYSQL_TYPE_STRING; b[3].buffer = (void*)u.createdAt.data(); b[3].buffer_length = (unsigned long)u.createdAt.size(); b[3].length = &cLen;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
bool MysqlStore::getUser(const std::string& username, UserRecord& out) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "SELECT username,salt,password_hash,created_at FROM accounts WHERE username=?";
  bool found = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb;
    memset(&pb, 0, sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type = MYSQL_TYPE_STRING; pb.buffer = (void*)username.data(); pb.buffer_length = (unsigned long)username.size(); pb.length = &ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char name[128]={0}, salt[128]={0}, hash[256]={0}, created[128]={0};
      unsigned long nameLen=0,saltLen=0,hashLen=0,createdLen=0;
      MYSQL_BIND rb[4]; memset(rb,0,sizeof(rb));
      rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=name; rb[0].buffer_length=sizeof(name); rb[0].length=&nameLen;
      rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=salt; rb[1].buffer_length=sizeof(salt); rb[1].length=&saltLen;
      rb[2].buffer_type=MYSQL_TYPE_STRING; rb[2].buffer=hash; rb[2].buffer_length=sizeof(hash); rb[2].length=&hashLen;
      rb[3].buffer_type=MYSQL_TYPE_STRING; rb[3].buffer=created; rb[3].buffer_length=sizeof(created); rb[3].length=&createdLen;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0) {
        out.username.assign(name, nameLen);
        out.salt.assign(salt, saltLen);
        out.hash.assign(hash, hashLen);
        out.createdAt.assign(created, createdLen);
        found = true;
      }
    }
  }
  mysql_stmt_close(st);
  if (!found) impl_->up = false;
  return found;
}
bool MysqlStore::userExists(const std::string& username) {
  UserRecord tmp;
  return getUser(username, tmp);
}
std::vector<UserRecord> MysqlStore::loadAllUsers() {
  std::vector<UserRecord> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT username,salt,password_hash,created_at FROM accounts";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0 && mysql_stmt_execute(st) == 0) {
    MYSQL_RES* res = mysql_stmt_result_metadata(st);
    if (res) {
      char name[128]={0}, salt[128]={0}, hash[256]={0}, created[128]={0};
      unsigned long nameLen=0,saltLen=0,hashLen=0,createdLen=0;
      MYSQL_BIND rb[4]; memset(rb,0,sizeof(rb));
      rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=name; rb[0].buffer_length=sizeof(name); rb[0].length=&nameLen;
      rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=salt; rb[1].buffer_length=sizeof(salt); rb[1].length=&saltLen;
      rb[2].buffer_type=MYSQL_TYPE_STRING; rb[2].buffer=hash; rb[2].buffer_length=sizeof(hash); rb[2].length=&hashLen;
      rb[3].buffer_type=MYSQL_TYPE_STRING; rb[3].buffer=created; rb[3].buffer_length=sizeof(created); rb[3].length=&createdLen;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0) {
        while (mysql_stmt_fetch(st) == 0) {
          UserRecord u;
          u.username.assign(name, nameLen);
          u.salt.assign(salt, saltLen);
          u.hash.assign(hash, hashLen);
          u.createdAt.assign(created, createdLen);
          out.push_back(std::move(u));
        }
      }
      mysql_free_result(res);
    }
  }
  mysql_stmt_close(st);
  return out;
}
bool MysqlStore::savePlayer(const PlayerSave& s) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO player_saves(username,x,y,z,hp,level,updated_at,gold,equip_json,inventory_json) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?) "
                    "ON DUPLICATE KEY UPDATE x=VALUES(x),y=VALUES(y),z=VALUES(z),hp=VALUES(hp),level=VALUES(level),"
                    "updated_at=VALUES(updated_at),gold=VALUES(gold),equip_json=VALUES(equip_json),inventory_json=VALUES(inventory_json)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[10]; memset(b,0,sizeof(b));
    unsigned long ul = s.username.size(), el = s.equipJson.size(), il = s.inventoryJson.size();
    b[0].buffer_type=MYSQL_TYPE_STRING; b[0].buffer=(void*)s.username.data(); b[0].buffer_length=(unsigned long)s.username.size(); b[0].length=&ul;
    b[1].buffer_type=MYSQL_TYPE_DOUBLE; b[1].buffer=(void*)&s.x;
    b[2].buffer_type=MYSQL_TYPE_DOUBLE; b[2].buffer=(void*)&s.y;
    b[3].buffer_type=MYSQL_TYPE_DOUBLE; b[3].buffer=(void*)&s.z;
    b[4].buffer_type=MYSQL_TYPE_DOUBLE; b[4].buffer=(void*)&s.hp;
    b[5].buffer_type=MYSQL_TYPE_LONG;   b[5].buffer=(void*)&s.level;
    b[6].buffer_type=MYSQL_TYPE_LONGLONG; b[6].buffer=(void*)&s.updatedAtMs;
    b[7].buffer_type=MYSQL_TYPE_LONG;   b[7].buffer=(void*)&s.gold;
    b[8].buffer_type=MYSQL_TYPE_STRING; b[8].buffer=(void*)s.equipJson.data(); b[8].buffer_length=(unsigned long)s.equipJson.size(); b[8].length=&el;
    b[9].buffer_type=MYSQL_TYPE_STRING; b[9].buffer=(void*)s.inventoryJson.data(); b[9].buffer_length=(unsigned long)s.inventoryJson.size(); b[9].length=&il;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
bool MysqlStore::loadPlayer(const std::string& username, PlayerSave& out) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "SELECT username,x,y,z,hp,level,updated_at,gold,equip_json,inventory_json FROM player_saves WHERE username=?";
  bool found = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb,0,sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)username.data(); pb.buffer_length=(unsigned long)username.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char name[128]={0}; unsigned long nameLen=0;
      double x=0,y=0,z=0,hp=100; int level=1; long long upd=0;
      long long gold=0;
      char eq[1024]={0}, inv[4096]={0};
      unsigned long eqLen=0, invLen=0;
      MYSQL_BIND rb[10]; memset(rb,0,sizeof(rb));
      rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=name; rb[0].buffer_length=sizeof(name); rb[0].length=&nameLen;
      rb[1].buffer_type=MYSQL_TYPE_DOUBLE; rb[1].buffer=&x;
      rb[2].buffer_type=MYSQL_TYPE_DOUBLE; rb[2].buffer=&y;
      rb[3].buffer_type=MYSQL_TYPE_DOUBLE; rb[3].buffer=&z;
      rb[4].buffer_type=MYSQL_TYPE_DOUBLE; rb[4].buffer=&hp;
      rb[5].buffer_type=MYSQL_TYPE_LONG; rb[5].buffer=&level;
      rb[6].buffer_type=MYSQL_TYPE_LONGLONG; rb[6].buffer=&upd;
      rb[7].buffer_type=MYSQL_TYPE_LONG; rb[7].buffer=&gold;
      rb[8].buffer_type=MYSQL_TYPE_STRING; rb[8].buffer=eq; rb[8].buffer_length=sizeof(eq); rb[8].length=&eqLen;
      rb[9].buffer_type=MYSQL_TYPE_STRING; rb[9].buffer=inv; rb[9].buffer_length=sizeof(inv); rb[9].length=&invLen;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0) {
        out.username = username;
        out.x=(float)x; out.y=(float)y; out.z=(float)z; out.hp=(float)hp; out.level=level;
        out.updatedAtMs=(uint64_t)upd;
        out.gold=(uint32_t)gold;
        out.equipJson.assign(eq, eqLen);
        out.inventoryJson.assign(inv, invLen);
        found = true;
      }
    }
  }
  mysql_stmt_close(st);
  if (!found) impl_->up = false;
  return found;
}
#else
// ---------------- 无 MySQL 头文件：编译为空实现（永远不可用 → 全内存） ----------------
// 占位完整类型：让 ~MysqlStore()=default（unique_ptr<MysqlImpl>）在严格编译器下可编译
struct MysqlImpl {};
MysqlStore::MysqlStore(const StoreConfig& sc) : sc_(sc) {}
MysqlStore::~MysqlStore() = default;
bool MysqlStore::init() { return false; }
bool MysqlStore::available() const { return false; }
bool MysqlStore::upsertUser(const UserRecord&) { return false; }
bool MysqlStore::getUser(const std::string&, UserRecord&) { return false; }
bool MysqlStore::userExists(const std::string&) { return false; }
std::vector<UserRecord> MysqlStore::loadAllUsers() { return {}; }
bool MysqlStore::savePlayer(const PlayerSave&) { return false; }
bool MysqlStore::loadPlayer(const std::string&, PlayerSave&) { return false; }
#endif

} // namespace ew
