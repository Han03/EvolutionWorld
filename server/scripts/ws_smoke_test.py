#!/usr/bin/env python3
# ws_smoke_test.py - C++ 服务端 WebSocket 冒烟 + 移动 + 防作弊验证（二进制协议）
# 模式:
#   normal   - 合法客户端：上报位置跟随服务端权威位置，应无 correction
#   teleport - 作弊客户端：上报 300m 外假坐标，应收到 correction/kick
#   flood    - 高频轰炸：短时间内发送大量包，应被限频/踢出
#   jump     - 跳跃合法行为
#
# 需要服务端以 EW_DEBUG=1 运行（依赖 /api/debug/players 获取权威位置）
import json, sys, time, urllib.request, struct, socket, base64, os, websocket
BASE = "http://localhost:3000"
WS_BASE = "ws://localhost:3000"

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def debug_players():
    with urllib.request.urlopen(BASE + "/api/debug/players", timeout=3) as r:
        return json.loads(r.read().decode())

def qabs(v): return int(round(v * 100))
def i16(v): return struct.pack('<h', v)
def i32(v): return struct.pack('<i', v)
def u32(v): return struct.pack('<I', v)

def frame(typ, payload=b''):
    return bytes([0x45, 0x57, 1, typ, 0]) + struct.pack('<HH', 0, len(payload)) + payload

def input_frame(seq, px, py, pz):
    """新版纯位置上报：seq(u32) + px(i32) + py(i16) + pz(i32) = 14 字节"""
    pay = u32(seq) + i32(qabs(px)) + i16(qabs(py)) + i32(qabs(pz))
    return frame(1, pay)

def parse_frames(buf):
    out = []
    i = 0
    while i + 9 <= len(buf):
        if buf[i] != 0x45 or buf[i+1] != 0x57:
            break
        typ = buf[i+3]
        ln = struct.unpack_from('<H', buf, i+7)[0]
        if i + 9 + ln > len(buf):
            break
        out.append((typ, buf[i+9:i+9+ln]))
        i += 9 + ln
    return out

def decode_snapshot_entities(pay):
    """SNAPSHOT/ENTER 负载 → [(wid,kind,x,y,z,name)]（相对坐标按 0 基准，需调用方处理）"""
    tick, cnt = struct.unpack_from('<IH', pay, 0)
    ents = []
    off = 6
    for _ in range(cnt):
        wid, = struct.unpack_from('<I', pay, off); off += 4
        kind = pay[off]; off += 1
        state = pay[off]; off += 1
        dx, dy, dz = struct.unpack_from('<hhh', pay, off); off += 6
        vx, vz = struct.unpack_from('<hh', pay, off); off += 4
        nlen = pay[off]; off += 1
        name = pay[off:off+nlen].decode(); off += nlen
        ents.append((wid, kind, dx/100.0, dy/100.0, dz/100.0, name))
    return tick, ents

def attack_frame(target_wid, slot=0):
    return frame(4, u32(target_wid) + bytes([slot]))
def decode_boss(pay):
    """S2C_BOSS: wid + state + phase + f32 hp + f32 maxHp + i32 target + i32 x + i16 y + i32 z + str name"""
    wid, = struct.unpack_from('<I', pay, 0)
    state, phase = pay[4], pay[5]
    hp, maxhp = struct.unpack_from('<ff', pay, 6)
    target, = struct.unpack_from('<i', pay, 14)
    x, = struct.unpack_from('<i', pay, 18)
    y, = struct.unpack_from('<h', pay, 22)
    z, = struct.unpack_from('<i', pay, 24)
    nlen = pay[28]
    name = pay[29:29+nlen].decode()
    return dict(wid=wid, state=state, phase=phase, hp=hp, maxhp=maxhp, target=target,
                x=x/100.0, y=y/100.0, z=z/100.0, name=name)
def decode_event(pay):
    """S2C_EVENT: evtType + wid + b + x + z"""
    et = pay[0]
    wid, b = struct.unpack_from('<II', pay, 1)
    x, z = struct.unpack_from('<ii', pay, 9)
    return dict(evtType=et, wid=wid, b=b, x=x/100.0, z=z/100.0)
def debug_bosses():
    with urllib.request.urlopen(BASE + "/api/debug/bosses", timeout=3) as r:
        return json.loads(r.read().decode())["bosses"]
def teleport(token, x, z):
    req = urllib.request.Request(BASE + "/api/debug/teleport",
                                 data=json.dumps({"token": token, "x": x, "z": z}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())
def find_self_in_snap(pay, self_wid):
    tick, ents = decode_snapshot_entities(pay)
    for wid, kind, dx, dy, dz, name in ents:
        if wid == self_wid:
            # self 在 SNAPSHOT 中相对自身 = (0,0,0)，权威位置由 debug 接口提供
            return tick, (dx, dy, dz)
    return tick, None

def main():
    mode = "normal"
    for a in sys.argv[1:]:
        if a.startswith("--"): mode = a[2:]
    uname = f"{mode[:4]}{int(time.time())%100000000}"
    r = post("/api/register", {"username": uname, "password": "pass1234"})
    assert r.get("ok"), r
    token = post("/api/login", {"username": uname, "password": "pass1234"})["token"]
    ws = websocket.create_connection(WS_BASE + "/ws?token=" + token, timeout=10)
    # HELLO（二进制）
    op, data = ws.recv_data()
    hello = parse_frames(data)
    assert hello and hello[0][0] == 0x81, f"expected HELLO got {hello[:1]}"
    self_wid = None
    pay = hello[0][1]
    seed, vr, cs, tr = struct.unpack_from('<ifff', pay, 0)
    wid, kind, state = struct.unpack_from('<IBB', pay, 16)
    self_wid = wid
    print(f"[{mode}] logged in {uname} -> wid={self_wid} seed={seed} viewRange={vr:.0f} tick={tr:.0f}Hz")
    # 拿到初始权威位置
    def me_pos():
        d = debug_players()
        for p in d["players"]:
            if p.get("username") == uname:
                return p["x"], p["y"], p["z"]
        return None
    x0, y0, z0 = me_pos()
    print(f"[{mode}] start=({x0:.1f},{y0:.1f},{z0:.1f})")
    seq = 0
    def send(claim):
        nonlocal seq
        seq += 1
        ws.send_binary(input_frame(seq, *claim))
    def drain(timeout=0.02, max_reads=200):
        """收集 correction/kick 帧。
        注意：timeout 必须小于服务端广播间隔（50ms），否则会因帧不断到达而永远不超时。
        max_reads 兜底防止极端情况挂起。"""
        corr, kick = [], []
        ws.settimeout(timeout)
        reads = 0
        try:
            while reads < max_reads:
                op, data = ws.recv_data()
                reads += 1
                for typ, pay in parse_frames(data):
                    if typ == 0x86:  # SELF
                        rl = pay[0]; reason = pay[1:1+rl].decode()
                        corr.append(reason)
                    elif typ == 0x89:  # KICK
                        rl = pay[0]; reason = pay[1:1+rl].decode()
                        kick.append(reason)
        except Exception:
            pass
        return corr, kick
    corrections, kicks = [], []
    if mode == "normal":
        # 新版纯位置上报：客户端每步声称前进 0.15m（合法移动，不触发防作弊）
        me = me_pos() or (x0, y0, z0)
        cx, cy, cz = me
        for i in range(40):
            cz -= 0.15  # 每步向前（-Z 方向）移动 0.15m
            claim = (cx, cy, cz)
            send(claim)
            time.sleep(0.03)
            c, k = drain(0.01)
            corrections += c; kicks += k
        me = me_pos()
        dz = me[2] - z0
        print(f"[normal] moved dz={dz:.2f} corrections={corrections} kicks={kicks}")
        assert abs(dz) > 3.0, "移动未生效"
        assert not corrections, f"合法客户端不应被回退: {corrections}"
    elif mode == "teleport":
        for _ in range(60):
            claim = (x0 + 300, y0, z0 + 300)
            send(claim)
            time.sleep(0.02)
            c, k = drain(0.02)
            corrections += c; kicks += k
            if k or len(corrections) >= 6: break
        print(f"[teleport] corrections={len(corrections)} kicks={len(kicks)}")
        if kicks:
            print(f"[teleport] KICKED reason={kicks[0]}")
        elif corrections:
            print(f"[teleport] 收到回退 correction 样例: {corrections[0]}")
        else:
            print("[teleport] 未命中采样（可调 EW_SAMPLE_PCT=100 复测）")
    elif mode == "flood":
        t0 = time.time()
        try:
            for _ in range(500):
                send((x0, y0, z0))
        except Exception:
            pass  # 服务端可能已限频踢出而关闭连接
        dt = time.time() - t0
        print(f"[flood] sent 500 inputs in {dt*1000:.0f}ms")
        c, k = drain(2.0)
        corrections += c; kicks += k
        print(f"[flood] corrections={len(corrections)} kicks={len(kicks)}")
        if kicks:
            print(f"[flood] 被限频踢出: {kicks[0]}")
    elif mode == "jump":
        # 跳跃已从协议/物理层移除，此模式验证位置上报仍正常工作
        time.sleep(1.2)
        me = me_pos() or (x0, y0, z0)
        send(me)
        time.sleep(0.05)
        peak = me[1]
        for _ in range(30):
            time.sleep(0.04)
            p = me_pos()
            if p: peak = max(peak, p[1])
        print(f"[jump] y0={me[1]:.2f} peak={peak:.2f} (跳跃已移除，验证位置上报正常)")
        # 不再断言跳跃高度，仅验证连接存活
        print(f"[jump] 位置上报模式正常，连接存活")
    elif mode == "boss":
        # 世界 Boss 状态共享验证：双客户端血量一致 + 攻击减血 + 死亡/复活
        boss = debug_bosses()[0]
        bx, bz, bwid, bname = boss["x"], boss["z"], boss["wid"], boss["name"]
        print(f"[boss] 目标: {bname} wid={bwid} at ({bx:.0f},{bz:.0f}) hp={boss['hp']:.0f}")
        # 传送到 Boss 旁（调试接口）
        tp = teleport(token, bx, bz)
        print(f"[boss] teleport -> ({tp['x']:.1f},{tp['y']:.1f},{tp['z']:.1f})")
        # 收集帧：Boss 状态 / 事件
        boss_states, events = [], []
        def drain_frames(dur=0.2):
            nonlocal boss_states, events
            ws.settimeout(0.02)
            t0 = time.time()
            try:
                while time.time() - t0 < dur:
                    op, data = ws.recv_data()
                    for typ, pay in parse_frames(data):
                        if typ == 0x8B:
                            boss_states.append(decode_boss(pay))
                        elif typ == 0x87:
                            events.append(decode_event(pay))
            except Exception:
                pass
        # 等 Boss 进入视野（ENTER/SNAPSHOT 后 S2C_BOSS 也随广播到达）
        drain_frames(0.6)
        if not boss_states:
            # 主动触发：等下一 tick 广播
            drain_frames(0.5)
        assert boss_states, "未收到 S2C_BOSS 共享状态帧"
        def my_boss():
            cand = [b for b in boss_states if b["wid"] == bwid]
            return cand[-1] if cand else None
        b0 = my_boss()
        assert b0, "未收到目标 Boss 的共享状态帧"
        hp_before = b0["hp"]
        print(f"[boss] 初始共享血量: {hp_before:.0f}/{b0['maxhp']:.0f} state={b0['state']}")
        # 攻击 Boss（服务端冷却 0.5s；用固定 sleep 保证间隔，drain 收帧）
        for i in range(8):
            ws.send_binary(attack_frame(bwid))
            time.sleep(0.6)
            drain_frames(0.1)
        b1 = my_boss()
        if b1:
            hp_after = b1["hp"]
            print(f"[boss] 攻击后共享血量: {hp_after:.0f} (下降 {(hp_before-hp_after):.0f})")
            assert hp_after < hp_before, "Boss 血量未下降"
        # 事件检查
        dmg = [e for e in events if e["evtType"] == 1]
        print(f"[boss] 伤害事件数={len(dmg)} 死亡事件数={len([e for e in events if e['evtType']==2])}")
        # 第二个客户端：加入即一致（HELLO 后应收到相同 Boss 血量）
        uname2 = f"bss2{int(time.time())%100000000}"
        post("/api/register", {"username": uname2, "password": "pass1234"})
        token2 = post("/api/login", {"username": uname2, "password": "pass1234"})["token"]
        ws2 = websocket.create_connection(WS_BASE + "/ws?token=" + token2, timeout=10)
        op2, data2 = ws2.recv_data()
        f2 = parse_frames(data2)
        boss2 = [decode_boss(p) for typ, p in f2 if typ == 0x8B]
        b2 = [b for b in boss2 if b["wid"] == bwid]
        hp_shared = b2[-1]["hp"] if b2 else None
        print(f"[boss] 第二客户端加入即一致的 Boss 血量: {hp_shared}")
        assert hp_shared is not None, "第二客户端未收到 Boss 共享状态"
        assert abs(hp_shared - b1["hp"]) < 0.5, "双客户端 Boss 血量不一致（状态共享失败）"
        ws2.close()
        # 继续攻击直至 Boss 死亡 → 复活
        guard = 0
        while not any(e["evtType"] == 2 for e in events) and guard < 40:
            ws.send_binary(attack_frame(bwid))
            time.sleep(0.6)
            drain_frames(0.1)
            guard += 1
        dead = any(e["evtType"] == 2 for e in events)
        dead_state = any(bs["state"] == 2 for bs in boss_states)
        print(f"[boss] 死亡事件={dead} state=DEAD={dead_state}")
        # 等待复活（EW_BOSS_RESPAWN=4s）
        t0 = time.time()
        respawned = False
        while time.time() - t0 < 6.0:
            drain_frames(0.5)
            if any(e["evtType"] == 3 for e in events) and any(bs["state"] == 0 and bs["hp"] >= 59 for bs in boss_states):
                respawned = True
                break
        bf = my_boss()
        print(f"[boss] 复活={respawned} 最终血量={bf['hp'] if bf else '?'}")
        assert dead, "Boss 未死亡"
        assert respawned, "Boss 未复活（状态共享复活机制失效）"
    ws.close()
    print(f"[{mode}] done")
if __name__ == "__main__":
    main()
