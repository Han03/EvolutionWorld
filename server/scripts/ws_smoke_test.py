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

def input_frame(seq, mx, mz, jump, px, py, pz):
    pay = u32(seq) + i16(int(round(mx*1000))) + i16(int(round(mz*1000))) + bytes([1 if jump else 0]) \
          + i32(qabs(px)) + i16(qabs(py)) + i32(qabs(pz))
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
    def send(mx, mz, claim, jump=False):
        nonlocal seq
        seq += 1
        ws.send_binary(input_frame(seq, mx, mz, jump, *claim))
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
        me = me_pos()
        for i in range(40):
            claim = (me[0], me[1], me[2])  # 用服务端权威位置作为预测基准
            send(0, -1, claim)
            time.sleep(0.03)
            me = me_pos() or me
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
            send(0, 0, claim)
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
                send(0, -1, (x0, y0, z0))
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
        # 等待落地（出生点略高于地表，需先落到地面才能起跳）
        time.sleep(1.2)
        me = me_pos() or (x0, y0, z0)
        send(0, 0, me, jump=True)
        time.sleep(0.05)
        peak = me[1]
        for _ in range(30):
            time.sleep(0.04)
            p = me_pos()
            if p: peak = max(peak, p[1])
        print(f"[jump] y0={me[1]:.2f} peak={peak:.2f} 升高={(peak-me[1]):.2f}m")
        assert peak - me[1] > 1.0, "跳跃未生效"
    ws.close()
    print(f"[{mode}] done")
if __name__ == "__main__":
    main()
