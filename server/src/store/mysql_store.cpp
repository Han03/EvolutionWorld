// mysql_store.cpp - MySQL 存储后端实现（libmysqlclient C API + 预处理语句防注入）
#include "mysql_store.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <tuple>
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
      " inventory_json TEXT,"
      " exp BIGINT NOT NULL DEFAULT 0,"
      " warehouse_json TEXT"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS world_data ("
      " k VARCHAR(64) PRIMARY KEY,"
      " v LONGTEXT NOT NULL"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS friends ("
      " id BIGINT AUTO_INCREMENT PRIMARY KEY,"
      " username VARCHAR(64) NOT NULL,"
      " friend_name VARCHAR(64) NOT NULL,"
      " since_ms BIGINT NOT NULL DEFAULT 0,"
      " UNIQUE KEY uq_pair (username, friend_name),"
      " KEY idx_user (username)"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS blocks ("
      " id BIGINT AUTO_INCREMENT PRIMARY KEY,"
      " username VARCHAR(64) NOT NULL,"
      " blocked_name VARCHAR(64) NOT NULL,"
      " UNIQUE KEY uq_pair (username, blocked_name),"
      " KEY idx_user (username)"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS guilds ("
      " guild_id INT PRIMARY KEY,"
      " name VARCHAR(128) NOT NULL DEFAULT '',"
      " notice TEXT,"
      " leader_username VARCHAR(64) NOT NULL DEFAULT '',"
      " member_count INT NOT NULL DEFAULT 0,"
      " max_members INT NOT NULL DEFAULT 50,"
      " level BIGINT NOT NULL DEFAULT 1,"
      " exp BIGINT NOT NULL DEFAULT 0,"
      " logo INT NOT NULL DEFAULT 0,"
      " created_ms BIGINT NOT NULL DEFAULT 0"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS guild_members ("
      " guild_id INT NOT NULL,"
      " username VARCHAR(64) NOT NULL,"
      " members_json LONGTEXT,"
      " PRIMARY KEY (guild_id, username),"
      " KEY idx_guild (guild_id)"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
      "CREATE TABLE IF NOT EXISTS player_quests ("
      " username VARCHAR(64) PRIMARY KEY,"
      " quests_json LONGTEXT NOT NULL"
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;";
  if (mysql_query(m.conn, kTables) != 0) {
    fprintf(stderr, "[store] MySQL 建表失败: %s —— 降级到内存存储\n", mysql_error(m.conn));
    mysql_close(m.conn);
    m.conn = nullptr;
    return false;
  }
  // 幂等迁移：旧库 player_saves 缺 exp 列时补上（列已存在报错 1060 忽略）
  if (mysql_query(m.conn, "ALTER TABLE player_saves ADD COLUMN exp BIGINT NOT NULL DEFAULT 0") != 0) {
    if (mysql_errno(m.conn) != 1060) {
      fprintf(stderr, "[store] MySQL player_saves.exp 迁移提示: %s\n", mysql_error(m.conn));
    }
  }
  // 幂等迁移：旧库 player_saves 缺 warehouse_json 列时补上（阶段5 仓库）
  if (mysql_query(m.conn, "ALTER TABLE player_saves ADD COLUMN warehouse_json TEXT") != 0) {
    if (mysql_errno(m.conn) != 1060) {
      fprintf(stderr, "[store] MySQL player_saves.warehouse_json 迁移提示: %s\n", mysql_error(m.conn));
    }
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
  const char* sql = "INSERT INTO player_saves(username,x,y,z,hp,level,updated_at,gold,equip_json,inventory_json,exp,warehouse_json) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON DUPLICATE KEY UPDATE x=VALUES(x),y=VALUES(y),z=VALUES(z),hp=VALUES(hp),level=VALUES(level),"
                    "updated_at=VALUES(updated_at),gold=VALUES(gold),equip_json=VALUES(equip_json),inventory_json=VALUES(inventory_json),exp=VALUES(exp),warehouse_json=VALUES(warehouse_json)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[12]; memset(b,0,sizeof(b));
    unsigned long ul = s.username.size(), el = s.equipJson.size(), il = s.inventoryJson.size(), wl = s.warehouseJson.size();
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
    b[10].buffer_type=MYSQL_TYPE_LONGLONG; b[10].buffer=(void*)&s.exp;
    b[11].buffer_type=MYSQL_TYPE_STRING; b[11].buffer=(void*)s.warehouseJson.data(); b[11].buffer_length=(unsigned long)s.warehouseJson.size(); b[11].length=&wl;
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
  const char* sql = "SELECT username,x,y,z,hp,level,updated_at,gold,equip_json,inventory_json,exp,warehouse_json FROM player_saves WHERE username=?";
  bool found = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb,0,sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)username.data(); pb.buffer_length=(unsigned long)username.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char name[128]={0}; unsigned long nameLen=0;
      double x=0,y=0,z=0,hp=100; int level=1; long long upd=0;
      long long gold=0;
      long long exp=0;
      char eq[1024]={0}, inv[4096]={0}, wh[16384]={0};
      unsigned long eqLen=0, invLen=0, whLen=0;
      MYSQL_BIND rb[12]; memset(rb,0,sizeof(rb));
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
      rb[10].buffer_type=MYSQL_TYPE_LONGLONG; rb[10].buffer=&exp;
      rb[11].buffer_type=MYSQL_TYPE_STRING; rb[11].buffer=wh; rb[11].buffer_length=sizeof(wh); rb[11].length=&whLen;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0) {
        out.username = username;
        out.x=(float)x; out.y=(float)y; out.z=(float)z; out.hp=(float)hp; out.level=level;
        out.updatedAtMs=(uint64_t)upd;
        out.gold=(uint32_t)gold;
        out.exp=(uint64_t)exp;
        out.equipJson.assign(eq, eqLen);
        out.inventoryJson.assign(inv, invLen);
        out.warehouseJson.assign(wh, whLen);
        found = true;
      }
    }
  }
  mysql_stmt_close(st);
  if (!found) impl_->up = false;
  return found;
}
// 世界数据（地形 mask + 出生点）：值可达数百 KB（LONGTEXT），读用大堆缓冲区
bool MysqlStore::saveWorldData(const std::string& key, const std::string& val) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO world_data(k,v) VALUES(?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[2]; memset(b,0,sizeof(b));
    unsigned long kl = key.size(), vl = val.size();
    b[0].buffer_type=MYSQL_TYPE_STRING; b[0].buffer=(void*)key.data(); b[0].buffer_length=(unsigned long)key.size(); b[0].length=&kl;
    b[1].buffer_type=MYSQL_TYPE_STRING; b[1].buffer=(void*)val.data(); b[1].buffer_length=(unsigned long)val.size(); b[1].length=&vl;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
bool MysqlStore::loadWorldData(const std::string& key, std::string& out) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "SELECT v FROM world_data WHERE k=?";
  bool found = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb,0,sizeof(pb));
    unsigned long ul = key.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)key.data(); pb.buffer_length=(unsigned long)key.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      const size_t CAP = 8u * 1024u * 1024u;   // 8MB：足以容纳 mask(b64)+出生点
      std::vector<char> buf(CAP);
      unsigned long vLen = 0;
      MYSQL_BIND rb; memset(&rb,0,sizeof(rb));
      rb.buffer_type=MYSQL_TYPE_STRING; rb.buffer=buf.data(); rb.buffer_length=(unsigned long)CAP; rb.length=&vLen;
      if (mysql_stmt_bind_result(st, &rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0 && vLen <= CAP) {
        out.assign(buf.data(), vLen);
        found = true;
      }
    }
  }
  mysql_stmt_close(st);
  // 未命中（首次启动尚无世界数据）属正常情形，不视为连接故障
  return found;
}

// ============ 社交系统：好友 ============
bool MysqlStore::addFriend(const std::string& a, const std::string& b) {
  if (!available()) return false;
  uint64_t now = (uint64_t)time(nullptr) * 1000;
  auto exec = [&](const std::string& u, const std::string& f) {
    MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
    if (!st) return false;
    const char* sql = "INSERT INTO friends(username,friend_name,since_ms) VALUES(?,?,?) "
                      "ON DUPLICATE KEY UPDATE since_ms=VALUES(since_ms)";
    bool ok = false;
    if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
      MYSQL_BIND bd[3]; memset(bd, 0, sizeof(bd));
      unsigned long ul = u.size(), fl = f.size();
      long long sms = (long long)now;
      bd[0].buffer_type=MYSQL_TYPE_STRING; bd[0].buffer=(void*)u.data(); bd[0].buffer_length=(unsigned long)u.size(); bd[0].length=&ul;
      bd[1].buffer_type=MYSQL_TYPE_STRING; bd[1].buffer=(void*)f.data(); bd[1].buffer_length=(unsigned long)f.size(); bd[1].length=&fl;
      bd[2].buffer_type=MYSQL_TYPE_LONGLONG; bd[2].buffer=&sms;
      if (mysql_stmt_bind_param(st, bd) == 0 && mysql_stmt_execute(st) == 0) ok = true;
    }
    mysql_stmt_close(st);
    if (!ok) impl_->up = false;
    return ok;
  };
  return exec(a, b) && exec(b, a); // 双向写入
}
bool MysqlStore::removeFriend(const std::string& a, const std::string& b) {
  if (!available()) return false;
  auto exec = [&](const std::string& u, const std::string& f) {
    MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
    if (!st) return false;
    const char* sql = "DELETE FROM friends WHERE username=? AND friend_name=?";
    bool ok = false;
    if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
      MYSQL_BIND bd[2]; memset(bd, 0, sizeof(bd));
      unsigned long ul = u.size(), fl = f.size();
      bd[0].buffer_type=MYSQL_TYPE_STRING; bd[0].buffer=(void*)u.data(); bd[0].buffer_length=(unsigned long)u.size(); bd[0].length=&ul;
      bd[1].buffer_type=MYSQL_TYPE_STRING; bd[1].buffer=(void*)f.data(); bd[1].buffer_length=(unsigned long)f.size(); bd[1].length=&fl;
      if (mysql_stmt_bind_param(st, bd) == 0 && mysql_stmt_execute(st) == 0) ok = true;
    }
    mysql_stmt_close(st);
    return ok;
  };
  return exec(a, b) && exec(b, a);
}
std::vector<std::pair<std::string, uint64_t>> MysqlStore::loadFriends(const std::string& username) {
  std::vector<std::pair<std::string, uint64_t>> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT friend_name,since_ms FROM friends WHERE username=?";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)username.data(); pb.buffer_length=(unsigned long)username.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char name[128]={0}; unsigned long nameLen=0; long long sms=0;
      MYSQL_BIND rb[2]; memset(rb, 0, sizeof(rb));
      rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=name; rb[0].buffer_length=sizeof(name); rb[0].length=&nameLen;
      rb[1].buffer_type=MYSQL_TYPE_LONGLONG; rb[1].buffer=&sms;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0) {
        while (mysql_stmt_fetch(st) == 0) {
          out.emplace_back(std::string(name, nameLen), (uint64_t)sms);
        }
      }
    }
  }
  mysql_stmt_close(st);
  return out;
}
bool MysqlStore::addBlock(const std::string& a, const std::string& b) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO blocks(username,blocked_name) VALUES(?,?) "
                    "ON DUPLICATE KEY UPDATE blocked_name=blocked_name";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND bd[2]; memset(bd, 0, sizeof(bd));
    unsigned long ul = a.size(), bl = b.size();
    bd[0].buffer_type=MYSQL_TYPE_STRING; bd[0].buffer=(void*)a.data(); bd[0].buffer_length=(unsigned long)a.size(); bd[0].length=&ul;
    bd[1].buffer_type=MYSQL_TYPE_STRING; bd[1].buffer=(void*)b.data(); bd[1].buffer_length=(unsigned long)b.size(); bd[1].length=&bl;
    if (mysql_stmt_bind_param(st, bd) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
bool MysqlStore::removeBlock(const std::string& a, const std::string& b) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "DELETE FROM blocks WHERE username=? AND blocked_name=?";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND bd[2]; memset(bd, 0, sizeof(bd));
    unsigned long ul = a.size(), bl = b.size();
    bd[0].buffer_type=MYSQL_TYPE_STRING; bd[0].buffer=(void*)a.data(); bd[0].buffer_length=(unsigned long)a.size(); bd[0].length=&ul;
    bd[1].buffer_type=MYSQL_TYPE_STRING; bd[1].buffer=(void*)b.data(); bd[1].buffer_length=(unsigned long)b.size(); bd[1].length=&bl;
    if (mysql_stmt_bind_param(st, bd) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  return ok;
}
std::vector<std::string> MysqlStore::loadBlocks(const std::string& username) {
  std::vector<std::string> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT blocked_name FROM blocks WHERE username=?";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)username.data(); pb.buffer_length=(unsigned long)username.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char name[128]={0}; unsigned long nameLen=0;
      MYSQL_BIND rb; memset(&rb, 0, sizeof(rb));
      rb.buffer_type=MYSQL_TYPE_STRING; rb.buffer=name; rb.buffer_length=sizeof(name); rb.length=&nameLen;
      if (mysql_stmt_bind_result(st, &rb) == 0 && mysql_stmt_store_result(st) == 0) {
        while (mysql_stmt_fetch(st) == 0) out.emplace_back(name, nameLen);
      }
    }
  }
  mysql_stmt_close(st);
  return out;
}

// ============ 社交系统：公会 ============
bool MysqlStore::saveGuild(const GuildSave& g) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO guilds(guild_id,name,notice,leader_username,member_count,max_members,level,exp,logo,created_ms) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE "
                    "name=VALUES(name),notice=VALUES(notice),leader_username=VALUES(leader_username),"
                    "member_count=VALUES(member_count),max_members=VALUES(max_members),"
                    "level=VALUES(level),exp=VALUES(exp),logo=VALUES(logo),created_ms=VALUES(created_ms)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[10]; memset(b, 0, sizeof(b));
    unsigned long nl = g.name.size(), nl2 = g.notice.size(), ll = g.leaderUsername.size();
    int gid = (int)g.guildId, mc = (int)g.memberCount, mm = (int)g.maxMembers, lg = (int)g.logo;
    long long lv = (long long)g.level, xp = (long long)g.exp, cm = (long long)g.createdMs;
    b[0].buffer_type=MYSQL_TYPE_LONG; b[0].buffer=&gid;
    b[1].buffer_type=MYSQL_TYPE_STRING; b[1].buffer=(void*)g.name.data(); b[1].buffer_length=(unsigned long)g.name.size(); b[1].length=&nl;
    b[2].buffer_type=MYSQL_TYPE_STRING; b[2].buffer=(void*)g.notice.data(); b[2].buffer_length=(unsigned long)g.notice.size(); b[2].length=&nl2;
    b[3].buffer_type=MYSQL_TYPE_STRING; b[3].buffer=(void*)g.leaderUsername.data(); b[3].buffer_length=(unsigned long)g.leaderUsername.size(); b[3].length=&ll;
    b[4].buffer_type=MYSQL_TYPE_LONG; b[4].buffer=&mc;
    b[5].buffer_type=MYSQL_TYPE_LONG; b[5].buffer=&mm;
    b[6].buffer_type=MYSQL_TYPE_LONGLONG; b[6].buffer=&lv;
    b[7].buffer_type=MYSQL_TYPE_LONGLONG; b[7].buffer=&xp;
    b[8].buffer_type=MYSQL_TYPE_LONG; b[8].buffer=&lg;
    b[9].buffer_type=MYSQL_TYPE_LONGLONG; b[9].buffer=&cm;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
bool MysqlStore::loadGuild(uint32_t guildId, GuildSave& out) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "SELECT guild_id,name,notice,leader_username,member_count,max_members,level,exp,logo,created_ms FROM guilds WHERE guild_id=?";
  bool found = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    int gid = (int)guildId;
    MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
    pb.buffer_type=MYSQL_TYPE_LONG; pb.buffer=&gid;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      char nm[128]={0}, nt[1024]={0}, lu[128]={0};
      unsigned long nl=0,ntl=0,ll=0; int mc=0,mm=0,lg=0; long long lv=0,xp=0,cm=0;
      MYSQL_BIND rb[10]; memset(rb, 0, sizeof(rb));
      rb[0].buffer_type=MYSQL_TYPE_LONG; rb[0].buffer=&gid;
      rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=nm; rb[1].buffer_length=sizeof(nm); rb[1].length=&nl;
      rb[2].buffer_type=MYSQL_TYPE_STRING; rb[2].buffer=nt; rb[2].buffer_length=sizeof(nt); rb[2].length=&ntl;
      rb[3].buffer_type=MYSQL_TYPE_STRING; rb[3].buffer=lu; rb[3].buffer_length=sizeof(lu); rb[3].length=&ll;
      rb[4].buffer_type=MYSQL_TYPE_LONG; rb[4].buffer=&mc;
      rb[5].buffer_type=MYSQL_TYPE_LONG; rb[5].buffer=&mm;
      rb[6].buffer_type=MYSQL_TYPE_LONGLONG; rb[6].buffer=&lv;
      rb[7].buffer_type=MYSQL_TYPE_LONGLONG; rb[7].buffer=&xp;
      rb[8].buffer_type=MYSQL_TYPE_LONG; rb[8].buffer=&lg;
      rb[9].buffer_type=MYSQL_TYPE_LONGLONG; rb[9].buffer=&cm;
      if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0 && mysql_stmt_fetch(st) == 0) {
        out.guildId = (uint32_t)gid;
        out.name.assign(nm, nl); out.notice.assign(nt, ntl); out.leaderUsername.assign(lu, ll);
        out.memberCount = (uint32_t)mc; out.maxMembers = (uint32_t)mm;
        out.level = (uint64_t)lv; out.exp = (uint64_t)xp; out.logo = (uint32_t)lg;
        out.createdMs = (uint64_t)cm;
        found = true;
      }
    }
  }
  mysql_stmt_close(st);
  return found;
}
bool MysqlStore::deleteGuild(uint32_t guildId) {
  if (!available()) return false;
  // 删除公会成员
  {
    MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
    if (st) {
      const char* sql = "DELETE FROM guild_members WHERE guild_id=?";
      int gid = (int)guildId;
      MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
      pb.buffer_type=MYSQL_TYPE_LONG; pb.buffer=&gid;
      mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql));
      mysql_stmt_bind_param(st, &pb);
      mysql_stmt_execute(st);
      mysql_stmt_close(st);
    }
  }
  // 删除公会
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "DELETE FROM guilds WHERE guild_id=?";
  bool ok = false;
  int gid = (int)guildId;
  MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
  pb.buffer_type=MYSQL_TYPE_LONG; pb.buffer=&gid;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  return ok;
}
bool MysqlStore::saveGuildMembers(uint32_t guildId, const std::string& membersJson) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO guild_members(guild_id,username,members_json) VALUES(?,'_all',?) "
                    "ON DUPLICATE KEY UPDATE members_json=VALUES(members_json)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[2]; memset(b, 0, sizeof(b));
    int gid = (int)guildId;
    unsigned long jl = membersJson.size();
    b[0].buffer_type=MYSQL_TYPE_LONG; b[0].buffer=&gid;
    b[1].buffer_type=MYSQL_TYPE_STRING; b[1].buffer=(void*)membersJson.data(); b[1].buffer_length=(unsigned long)membersJson.size(); b[1].length=&jl;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
std::string MysqlStore::loadGuildMembers(uint32_t guildId) {
  if (!available()) return "";
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return "";
  const char* sql = "SELECT members_json FROM guild_members WHERE guild_id=? AND username='_all'";
  std::string result;
  int gid = (int)guildId;
  MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
  pb.buffer_type=MYSQL_TYPE_LONG; pb.buffer=&gid;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      const size_t CAP = 64u * 1024u;
      std::vector<char> buf(CAP);
      unsigned long jl = 0;
      MYSQL_BIND rb; memset(&rb, 0, sizeof(rb));
      rb.buffer_type=MYSQL_TYPE_STRING; rb.buffer=buf.data(); rb.buffer_length=(unsigned long)CAP; rb.length=&jl;
      if (mysql_stmt_bind_result(st, &rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0 && jl <= CAP) {
        result.assign(buf.data(), jl);
      }
    }
  }
  mysql_stmt_close(st);
  return result;
}
std::vector<uint32_t> MysqlStore::loadAllGuildIds() {
  std::vector<uint32_t> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT guild_id FROM guilds";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0 && mysql_stmt_execute(st) == 0) {
    int gid = 0;
    MYSQL_BIND rb; memset(&rb, 0, sizeof(rb));
    rb.buffer_type=MYSQL_TYPE_LONG; rb.buffer=&gid;
    if (mysql_stmt_bind_result(st, &rb) == 0 && mysql_stmt_store_result(st) == 0) {
      while (mysql_stmt_fetch(st) == 0) out.push_back((uint32_t)gid);
    }
  }
  mysql_stmt_close(st);
  return out;
}

// ============ 任务系统 ============
bool MysqlStore::saveQuests(const std::string& username, const std::string& questsJson) {
  if (!available()) return false;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return false;
  const char* sql = "INSERT INTO player_quests(username,quests_json) VALUES(?,?) "
                    "ON DUPLICATE KEY UPDATE quests_json=VALUES(quests_json)";
  bool ok = false;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND b[2]; memset(b, 0, sizeof(b));
    unsigned long ul = username.size(), jl = questsJson.size();
    b[0].buffer_type=MYSQL_TYPE_STRING; b[0].buffer=(void*)username.data(); b[0].buffer_length=(unsigned long)username.size(); b[0].length=&ul;
    b[1].buffer_type=MYSQL_TYPE_STRING; b[1].buffer=(void*)questsJson.data(); b[1].buffer_length=(unsigned long)questsJson.size(); b[1].length=&jl;
    if (mysql_stmt_bind_param(st, b) == 0 && mysql_stmt_execute(st) == 0) ok = true;
  }
  mysql_stmt_close(st);
  if (!ok) impl_->up = false;
  return ok;
}
std::string MysqlStore::loadQuests(const std::string& username) {
  if (!available()) return "";
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return "";
  const char* sql = "SELECT quests_json FROM player_quests WHERE username=?";
  std::string result;
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0) {
    MYSQL_BIND pb; memset(&pb, 0, sizeof(pb));
    unsigned long ul = username.size();
    pb.buffer_type=MYSQL_TYPE_STRING; pb.buffer=(void*)username.data(); pb.buffer_length=(unsigned long)username.size(); pb.length=&ul;
    if (mysql_stmt_bind_param(st, &pb) == 0 && mysql_stmt_execute(st) == 0) {
      const size_t CAP = 256u * 1024u;
      std::vector<char> buf(CAP);
      unsigned long jl = 0;
      MYSQL_BIND rb; memset(&rb, 0, sizeof(rb));
      rb.buffer_type=MYSQL_TYPE_STRING; rb.buffer=buf.data(); rb.buffer_length=(unsigned long)CAP; rb.length=&jl;
      if (mysql_stmt_bind_result(st, &rb) == 0 && mysql_stmt_store_result(st) == 0 &&
          mysql_stmt_fetch(st) == 0 && jl <= CAP) {
        result.assign(buf.data(), jl);
      }
    }
  }
  mysql_stmt_close(st);
  return result;
}

// ============ 批量加载（启动时填充内存后端用） ============
std::vector<std::tuple<std::string, std::string, uint64_t>> MysqlStore::loadAllFriends() {
  std::vector<std::tuple<std::string, std::string, uint64_t>> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT username,friend_name,since_ms FROM friends";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0 && mysql_stmt_execute(st) == 0) {
    char u[128]={0}, f[128]={0}; unsigned long ul=0, fl=0; long long sms=0;
    MYSQL_BIND rb[3]; memset(rb, 0, sizeof(rb));
    rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=u; rb[0].buffer_length=sizeof(u); rb[0].length=&ul;
    rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=f; rb[1].buffer_length=sizeof(f); rb[1].length=&fl;
    rb[2].buffer_type=MYSQL_TYPE_LONGLONG; rb[2].buffer=&sms;
    if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0) {
      while (mysql_stmt_fetch(st) == 0) out.emplace_back(std::string(u,ul), std::string(f,fl), (uint64_t)sms);
    }
  }
  mysql_stmt_close(st);
  return out;
}
std::vector<std::pair<std::string, std::string>> MysqlStore::loadAllBlocks() {
  std::vector<std::pair<std::string, std::string>> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT username,blocked_name FROM blocks";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0 && mysql_stmt_execute(st) == 0) {
    char u[128]={0}, b[128]={0}; unsigned long ul=0, bl=0;
    MYSQL_BIND rb[2]; memset(rb, 0, sizeof(rb));
    rb[0].buffer_type=MYSQL_TYPE_STRING; rb[0].buffer=u; rb[0].buffer_length=sizeof(u); rb[0].length=&ul;
    rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=b; rb[1].buffer_length=sizeof(b); rb[1].length=&bl;
    if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0) {
      while (mysql_stmt_fetch(st) == 0) out.emplace_back(std::string(u,ul), std::string(b,bl));
    }
  }
  mysql_stmt_close(st);
  return out;
}
std::vector<std::pair<uint32_t, std::string>> MysqlStore::loadAllGuildMembers() {
  std::vector<std::pair<uint32_t, std::string>> out;
  if (!available()) return out;
  MYSQL_STMT* st = mysql_stmt_init(impl_->conn);
  if (!st) return out;
  const char* sql = "SELECT guild_id,members_json FROM guild_members WHERE username='_all'";
  if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql)) == 0 && mysql_stmt_execute(st) == 0) {
    int gid=0; char buf[65536]={0}; unsigned long jl=0;
    MYSQL_BIND rb[2]; memset(rb, 0, sizeof(rb));
    rb[0].buffer_type=MYSQL_TYPE_LONG; rb[0].buffer=&gid;
    rb[1].buffer_type=MYSQL_TYPE_STRING; rb[1].buffer=buf; rb[1].buffer_length=sizeof(buf); rb[1].length=&jl;
    if (mysql_stmt_bind_result(st, rb) == 0 && mysql_stmt_store_result(st) == 0) {
      while (mysql_stmt_fetch(st) == 0) out.emplace_back((uint32_t)gid, std::string(buf, jl));
    }
  }
  mysql_stmt_close(st);
  return out;
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
bool MysqlStore::saveWorldData(const std::string&, const std::string&) { return false; }
bool MysqlStore::loadWorldData(const std::string&, std::string&) { return false; }
// 社交/任务空实现（无 MySQL 头文件时）
bool MysqlStore::addFriend(const std::string&, const std::string&) { return false; }
bool MysqlStore::removeFriend(const std::string&, const std::string&) { return false; }
std::vector<std::pair<std::string, uint64_t>> MysqlStore::loadFriends(const std::string&) { return {}; }
bool MysqlStore::addBlock(const std::string&, const std::string&) { return false; }
bool MysqlStore::removeBlock(const std::string&, const std::string&) { return false; }
std::vector<std::string> MysqlStore::loadBlocks(const std::string&) { return {}; }
bool MysqlStore::saveGuild(const GuildSave&) { return false; }
bool MysqlStore::loadGuild(uint32_t, GuildSave&) { return false; }
bool MysqlStore::deleteGuild(uint32_t) { return false; }
bool MysqlStore::saveGuildMembers(uint32_t, const std::string&) { return false; }
std::string MysqlStore::loadGuildMembers(uint32_t) { return ""; }
std::vector<uint32_t> MysqlStore::loadAllGuildIds() { return {}; }
bool MysqlStore::saveQuests(const std::string&, const std::string&) { return false; }
std::string MysqlStore::loadQuests(const std::string&) { return ""; }
std::vector<std::tuple<std::string, std::string, uint64_t>> MysqlStore::loadAllFriends() { return {}; }
std::vector<std::pair<std::string, std::string>> MysqlStore::loadAllBlocks() { return {}; }
std::vector<std::pair<uint32_t, std::string>> MysqlStore::loadAllGuildMembers() { return {}; }
#endif

} // namespace ew
