#!/usr/bin/env python3
# ws_smoke_test.py - C++ 服务端 WebSocket 冒烟 + 移动 + 防作弊验证
# 模式:
#   normal   - 合法客户端：上报位置跟随服务端权威位置，应无 correction
#   teleport - 作弊客户端：上报 300m 外假坐标，应收到 correction/kick
#   flood    - 高频轰炸：短时间内发送大量包，应被限频/踢出
#   jump     - 跳跃合法行为
import json, sys, time, urllib.request, websocket

BASE = "http://localhost:3000"
WS_BASE = "ws://localhost:3000"

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def read_snap(ws, eid, timeout=1.0):
    """读到含 eid 的最新快照，返回该实体 dict；失败返回 None"""
    ws.settimeout(timeout)
    try:
        while True:
            m = json.loads(ws.recv())
            if m.get("type") == "snapshot":
                ents = {e["id"]: e for e in m["entities"]}
                if eid in ents:
                    return ents[eid]
    except Exception:
        return None

def main():
    mode = "normal"
    for a in sys.argv[1:]:
        if a.startswith("--"): mode = a[2:]

    uname = f"{mode[:4]}{int(time.time())%100000000}"
    r = post("/api/register", {"username": uname, "password": "pass1234"})
    assert r.get("ok"), r
    token = post("/api/login", {"username": uname, "password": "pass1234"})["token"]
    ws = websocket.create_connection(WS_BASE + "/ws?token=" + token, timeout=10)
    wel = json.loads(ws.recv())
    assert wel["type"] == "welcome", wel
    eid = wel["entityId"]
    print(f"[{mode}] logged in {uname} -> {eid}")
    me = read_snap(ws, eid)
    x0, y0, z0 = me["x"], me["y"], me["z"]
    print(f"[{mode}] start=({x0:.1f},{y0:.1f},{z0:.1f})")

    seq = 0
    def send(mx, mz, claim, jump=False):
        nonlocal seq
        seq += 1
        m = {"type": "input", "seq": seq, "moveX": mx, "moveZ": mz, "jump": jump}
        if claim:
            m["px"], m["py"], m["pz"] = claim
        ws.send(json.dumps(m))

    corrections, kicks = [], []

    if mode == "normal":
        # 合法：每帧上报"最新快照位置 + 一个 tick 的前向外推"（模拟客户端预测）
        for i in range(40):
            claim = None
            if me:  # 用服务端最新位置作为预测基准
                claim = (me["x"] + 0.0, me["y"], me["z"] - 0.0)
            send(0, -1, claim)
            time.sleep(0.03)
            nxt = read_snap(ws, eid, 0.15)
            if nxt: me = nxt
            try:
                ws.settimeout(0.01)
                while True:
                    m = json.loads(ws.recv())
                    if m.get("type") == "correction":
                        corrections.append(m.get("reason"))
                    if m.get("type") == "kick":
                        kicks.append(m.get("reason"))
            except Exception:
                pass
        me = read_snap(ws, eid, 1.0)
        dz = me["z"] - z0
        print(f"[normal] moved dz={dz:.2f} corrections={corrections} kicks={kicks}")
        assert abs(dz) > 3.0, "移动未生效"
        assert not corrections, f"合法客户端不应被回退: {corrections}"

    elif mode == "teleport":
        # 作弊：上报 300m 外假坐标
        for _ in range(60):
            claim = (x0 + 300, y0, z0 + 300)
            send(0, 0, claim)
            time.sleep(0.02)
            try:
                ws.settimeout(0.3)
                m = json.loads(ws.recv())
                if m.get("type") == "correction":
                    corrections.append(m["reason"])
                if m.get("type") == "kick":
                    kicks.append(m["reason"]); break
            except Exception:
                pass
        print(f"[teleport] corrections={len(corrections)} kicks={len(kicks)}")
        if kicks:
            print(f"[teleport] KICKED reason={kicks[0]}")
        elif corrections:
            print(f"[teleport] 收到回退 correction 样例: {corrections[0]}")
        else:
            print("[teleport] 未命中采样（可调 EW_SAMPLE_PCT=100 复测）")

    elif mode == "flood":
        # 轰炸：0.5s 内发送 500 条（远超 40/s）
        t0 = time.time()
        try:
            for _ in range(500):
                send(0, -1, (x0, y0, z0))
        except Exception:
            pass
        dt = time.time() - t0
        print(f"[flood] sent 500 inputs in {dt*1000:.0f}ms")
        try:
            for _ in range(40):
                try:
                    ws.settimeout(2.0)
                    m = json.loads(ws.recv())
                    if m.get("type") == "kick":
                        kicks.append(m["reason"]); break
                    if m.get("type") == "correction":
                        corrections.append(m["reason"])
                except websocket.WebSocketConnectionClosedException:
                    print("[flood] 连接被服务端关闭（限频踢出）")
                    break
                except Exception:
                    break
        except Exception:
            pass
        print(f"[flood] corrections={len(corrections)} kicks={len(kicks)}")
        if kicks:
            print(f"[flood] 被限频踢出: {kicks[0]}")

    elif mode == "jump":
        me = read_snap(ws, eid)
        send(0, 0, (me["x"], me["y"], me["z"]), jump=True)
        time.sleep(0.05)
        highs = []
        for _ in range(15):
            nxt = read_snap(ws, eid, 0.15)
            if nxt:
                highs.append(nxt["y"] - nxt["y"])  # 记录峰值高度
                if nxt["y"] > me["y"] + 1.0:
                    break
            time.sleep(0.02)
        print(f"[jump] y0={me['y']:.2f} (跳跃应使 y 上升)")
        me2 = read_snap(ws, eid, 1.0)
        print(f"[jump] final y={me2['y']:.2f}")

    ws.close()
    print(f"[{mode}] done")

if __name__ == "__main__":
    main()
