/**
 * 网络客户端：HTTP 登录 + WebSocket（二进制协议）游戏连接
 * 数据传输方案：二进制帧 + 量化坐标 + AOI 进出 + 增量更新 + 校准快照
 * 扩展：输入上报携带预测位置 px/py/pz（防作弊校验），处理 SELF（回退）与 KICK。
 */
import { encodeInput, parseS2C, MSG } from './protocol.js';
export class NetworkClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.selfWid = 0;
    this.selfName = '';
    this.world = null;
    this.seq = 0;
    // 回调
    this.onHello = null;
    this.onEnter = null;
    this.onLeave = null;
    this.onUpdate = null;
    this.onSnapshot = null;
    this.onSelf = null;      // 服务端后校验回退
    this.onKick = null;
    this.onDisconnect = null;
    // 协议透传转换监控：每次二进制帧解码为可读对象后触发（dir: 's2c' | 'c2s'，obj 为解码结果）
    this.onProtocol = null;
    // 自身预测位置（解码相对坐标用参考）
    this.refX = 0; this.refY = 0; this.refZ = 0;
  }
  async _post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `请求失败(${res.status})`);
    }
    return data;
  }
  async register(username, password) {
    await this._post('/api/register', { username, password });
  }
  async login(username, password) {
    return this._post('/api/login', { username, password });
  }
  /** 建立 WebSocket 游戏连接（二进制协议） */
  connect(token) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      ws.onclose = () => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      };
      ws.onmessage = (ev) => this._onBinary(ev.data);
    });
  }
  /** 设置自身预测位置（相对坐标解码参考） */
  setRef(x, y, z) {
    this.refX = x; this.refY = y; this.refZ = z;
  }
  _onBinary(data) {
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.bytesRx = (this.bytesRx || 0) + buf.length;
    if (this.onBytes) this.onBytes(buf.length);
    let off = 0;
    while (off + 9 <= buf.length) {
      const m0 = buf[off], m1 = buf[off + 1];
      if (m0 !== 0x45 || m1 !== 0x57) break;
      const type = buf[off + 3];
      const len = buf[off + 7] | (buf[off + 8] << 8);
      if (off + 9 + len > buf.length) break;
      const payload = buf.slice(off + 9, off + 9 + len);
      off += 9 + len;
      this._dispatch(type, payload);
    }
  }
  _dispatch(type, payload) {
    try {
      const msg = parseS2C(type, payload, this.refX, this.refY, this.refZ);
      if (this.onProtocol) this.onProtocol('s2c', msg); // 透传转换：二进制 → 可读对象
      switch (msg.type) {
        case MSG.S2C_HELLO:
          this.selfWid = msg.self.wid;
          this.selfName = msg.self.name;
          this.world = { seed: msg.seed, viewRange: msg.viewRange, chunkSize: msg.chunkSize, tickRate: msg.tickRate };
          this.hello = msg;
          if (this.onHello) this.onHello(msg);
          break;
        case MSG.S2C_ENTER:
          if (this.onEnter) this.onEnter(msg.entities);
          break;
        case MSG.S2C_LEAVE:
          if (this.onLeave) this.onLeave(msg.wids);
          break;
        case MSG.S2C_UPDATE:
          if (this.onUpdate) this.onUpdate(msg.updates);
          break;
        case MSG.S2C_SNAPSHOT:
          if (this.onSnapshot) this.onSnapshot(msg);
          break;
        case MSG.S2C_SELF:
          if (this.onSelf) this.onSelf(msg);
          break;
        case MSG.S2C_KICK:
          if (this.onKick) this.onKick(msg);
          break;
        case MSG.S2C_PING:
          break;
        case MSG.S2C_ERROR:
          console.error('[net]', msg.code, msg.msg);
          break;
      }
    } catch (e) {
      console.error('[net] 解码错误', e);
    }
  }
  /**
   * 发送输入（移动 + 跳跃 + 预测位置），二进制编码
   */
  sendInput(moveX, moveZ, jump, pred) {
    if (!this.connected) return;
    const frame = encodeInput(++this.seq, moveX, moveZ, jump, pred.x, pred.y, pred.z);
    this.ws.send(frame);
    if (this.onProtocol) {
      this.onProtocol('c2s', { type: 'INPUT', seq: this.seq, moveX, moveZ, jump, x: pred.x, y: pred.y, z: pred.z });
    }
  }
  close() {
    this.connected = false;
    if (this.ws) this.ws.close();
  }
}
