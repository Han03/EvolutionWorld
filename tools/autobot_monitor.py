#!/usr/bin/env python3
"""autobot 本地监控订阅端（方案B：免截图监控客户端运行状态）。

客户端 autobot.js 已内嵌推送：日志实时 + 1s 状态快照 → ws://localhost:9100。
本进程接收并实时打印，同时追加写入 --out 文件，供外部 tail / 脚本监控，无需截图。

用法:
    python3 tools/autobot_monitor.py [--host 127.0.0.1] [--port 9100] [--out /tmp/autobot_monitor.log]
依赖:
    pip3 install websockets
"""
import argparse
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    print("缺少依赖：pip3 install websockets", file=sys.stderr)
    sys.exit(1)

OUT = ""  # 全局输出文件路径


async def handler(ws):
    while True:
        try:
            msg = await ws.recv()
        except Exception:
            break  # 连接关闭/异常
        ts = time.strftime("%H:%M:%S")
        try:
            obj = json.loads(msg)
            # 快照 JSON 较长，紧凑单行输出便于 grep/脚本解析；日志原样输出
            line = json.dumps(obj, ensure_ascii=False) if obj.get("t") == "snapshot" else msg
        except Exception:
            line = msg
        out = f"[{ts}] {line}"
        print(out, flush=True)
        if OUT:
            try:
                with open(OUT, "a", encoding="utf-8") as f:
                    f.write(out + "\n")
            except Exception:
                pass


async def main():
    global OUT
    ap = argparse.ArgumentParser(description="autobot 本地监控订阅端（方案B）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9100)
    ap.add_argument("--out", default="/tmp/autobot_monitor.log")
    a = ap.parse_args()
    OUT = a.out
    print(f"[monitor] listening ws://{a.host}:{a.port} → {OUT}", flush=True)
    async with websockets.serve(handler, a.host, a.port, max_size=1 << 20):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
