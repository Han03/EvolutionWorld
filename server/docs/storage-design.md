# EvolutionWorld 存储系统设计（MySQL + Redis，无 DB 不影响功能）

## 1. 目标与硬约束

- 基于 **MySQL + Redis** 设计并实现存储系统，支撑大型网游规模的账号、玩家存档、会话、缓存。
- **硬约束：不连接 MySQL 和 Redis 时也不能影响功能** —— 服务端必须在纯内存模式下完整可用。
- 存储抽象必须可扩展：后续接入新的外部存储（如分片 MySQL、Redis Cluster、KV 引擎）不改动业务代码。

## 2. 架构总览

```
                        ┌──────────────────────────────┐
                        │           业务层             │
                        │   Auth / World / Server      │
                        └──────────────┬───────────────┘
                                       │ 只依赖 IStore 抽象
                        ┌──────────────▼───────────────┐
                        │        Store 门面（门面模式） │
                        │   · 双写/路由/降级判定        │
                        └──────┬───────────────┬───────┘
                               │               │
              ┌────────────────▼──┐   ┌────────▼─────────┐
              │  MemoryStore(内存) │   │  外部后端(可选)   │
              │  永远可用·兜底     │   │  MySQLStore      │
              │  读权威           │   │  RedisStore      │
              └───────────────────┘   └──────────────────┘
```

**数据分层策略**：

| 数据类型        | 读权威            | 写入策略                       | 外部后端       |
|----------------|-------------------|-------------------------------|----------------|
| 账号           | 内存（启动灌入）  | 内存必写 + MySQL 尽力持久化     | MySQL `accounts` |
| 玩家存档        | MySQL 优先 + 内存 | 周期落盘 + 下线落盘，内存兜底    | MySQL `player_saves` |
| 会话 Token     | 内存 + Redis      | 内存必写 + Redis(EXPIRE TTL)   | Redis `sess:<token>` |
| 通用缓存       | Redis 优先 + 内存 | 双写                        | Redis `cache:<key>` |

## 3. 核心接口（store.h）

`IStore` 抽象接口（纯虚方法，业务层只依赖它）：

```cpp
class IStore {
  // 账号
  virtual bool upsertUser(const UserRecord&) = 0;
  virtual bool getUser(const std::string&, UserRecord&) = 0;
  virtual bool userExists(const std::string&) = 0;
  virtual std::vector<UserRecord> loadAllUsers();          // MySQL 启动灌入用
  // 玩家存档
  virtual bool savePlayer(const PlayerSave&) = 0;
  virtual bool loadPlayer(const std::string&, PlayerSave&) = 0;
  // 会话
  virtual bool putSession(const std::string& token, const std::string& username, uint32_t ttlSec) = 0;
  virtual std::string getSession(const std::string& token) = 0;
  virtual bool delSession(const std::string& token) = 0;
  // 通用缓存
  virtual bool cacheSet(const std::string& key, const std::string& val, uint32_t ttlSec) = 0;
  virtual bool cacheGet(const std::string& key, std::string& out) = 0;
  virtual bool cacheDel(const std::string& key) = 0;
  // 健康度
  virtual bool available() const = 0;       // 后端是否可用（断线 → false → 自动降级）
  virtual const char* backendName() const = 0;
};
```

## 4. 降级策略（无 DB 不影响功能的核心）

1. **启动探测**：`Store::init()` 尝试连接 Redis / MySQL。
   - 未配置环境变量 → 不尝试，直接纯内存。
   - 配置了但连接失败 → 打日志 `[store] ... 降级到内存（不影响功能）`，`available()=false`，**不抛异常不崩溃**。
2. **运行期断线**：Redis/MySQL 后端任何命令失败即标记不可用（`available()` 变 false），门面路由到内存。
3. **写路径双写**：`upsertUser/savePlayer/putSession/cacheSet` 先写内存（读权威，永不丢），再尽力写外部后端（失败静默降级）。
4. **读路径路由**：账号内存优先（MySQL 启动时灌入）、存档 MySQL 优先回退内存、会话/缓存 Redis 优先回退内存。
5. **启动灌入**：MySQL 可用时 `loadAllUsers()` 把全部账号灌入内存缓存 → 后续即使 MySQL 断线，读仍命中内存。

## 5. MySQL 后端（libmysqlclient，预处理语句防注入）

- **编译期检测**：Makefile 检测 `/usr/include/mysql/mysql.h`，存在则 `-DEW_HAVE_MYSQL=1` 并链接 `libmysqlclient`；不存在则编译空实现（永远不可用 → 全内存），**不因缺少 MySQL 开发库而编译失败**。
- **连接**：非阻塞式 `mysql_init + mysql_real_connect`（2s 超时）。
- **建表（幂等）**：
  - `accounts(username PK, salt, password_hash, created_at)` ENGINE=InnoDB utf8mb4
  - `player_saves(username PK, x, y, z, hp, level, updated_at)`
- **写入**：全部使用 `MYSQL_STMT` 预处理语句 + 绑定参数，**杜绝 SQL 注入**（用户名校验已限制 2-16 位字母/数字/下划线/中文，双层防护）。
- **断线**：`available()` 内部 `mysql_ping` 探测；写失败自动降级并关闭连接。

## 6. Redis 后端（自写 RESP 客户端，零第三方依赖）

- 环境无 hiredis，因此**自实现最小 RESP 协议客户端**（`redis_store.h/.cpp`）：
  - 非阻塞 `socket + connect + poll`（超时 1s），`TCP_NODELAY`。
  - 支持命令子集：`PING / AUTH / SET(EX) / GET / DEL / EXISTS / EXPIRE`。
  - 完整 RESP 回复解析：`+ 简单串 / - 错误 / : 整数 / $ 批量串 / * 数组`。
- **键设计**：统一前缀 `ew:`，会话 `sess:<token>`（TTL=sessionTtlSec，24h）、缓存 `cache:<key>`。
- **断线自愈降级**：任一命令失败自动 `close(fd)` 并置 `available()=false`，门面转内存。

## 7. 会话与账号在业务层的接入

- **Auth**：
  - 注册：内存写 + `users.json` 落盘（原有） + `store_.upsertUser`（同步 MySQL）。
  - 登录：签发 token 后 `store_.putSession(token, user, ttl)`（Redis EXPIRE + 内存）。
  - 校验：内存优先，未命中回退 `store_.getSession`（**多实例共享会话**——A 实例签发的 token B 实例可经 Redis 校验），命中回填本地。
  - 登出：内存 + `store_.delSession`。
- **World / Server**：
  - WS 登录：`store_.loadPlayer` 取存档作为出生点（无存档随机出生，不影响功能）。
  - 周期存档：每 100 tick（≈5s）`periodicSavePlayers()` 全量落盘。
  - 下线存档：`closeConn` 时 `savePlayerToStore` 落盘。

## 8. 配置（环境变量）

| 环境变量             | 说明                        | 示例                    |
|----------------------|-----------------------------|-------------------------|
| `EW_DB_MYSQL`        | MySQL host:port（未设置=不启用）| `127.0.0.1:3306`      |
| `EW_DB_MYSQL_USER`   | MySQL 用户                  | `root`                  |
| `EW_DB_MYSQL_PASS`   | MySQL 密码                  | `secret`                |
| `EW_DB_MYSQL_DB`     | MySQL 库名                  | `evolutionworld`        |
| `EW_DB_REDIS`        | Redis host:port（未设置=不启用）| `127.0.0.1:6379`      |
| `EW_DB_REDIS_PASS`   | Redis 密码（可选）           | `secret`                |
| `EW_DB_REDIS_PREFIX` | 键前缀（默认 `ew:`）         | `ew:`                   |

> 启动日志会打印当前存储状态（如 `MySQL(内存)+Redis(内存) [纯内存模式...]`），便于确认降级路径。

## 9. 大型网游规模扩展位

- **数据分片**：`IStore` 是单接口，后续可加 `ShardedStore` 门面按 `username hash` 路由到多 MySQL 实例；业务零改动。
- **异步落盘**：`savePlayer` 当前同步，可改为投递到落盘队列/写缓冲，批量刷盘（`buffer + flush`），避免高频写库。
- **缓存击穿/穿透**：`cacheGet` 未命中可加"回源 + 缓存"逻辑（loadPlayer 已天然支持 MySQL 回源）。
- **会话集群**：`sess:<token>` 已带 TTL，天然支持 Redis 集群 / 多服共享；后续可加 `GETSET` 续期（滑动过期）。
- **监控**：`available()/backendName()` 已暴露，可接入健康检查与指标上报。
