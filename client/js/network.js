/**
 * 网络客户端：HTTP 登录 + WebSocket 游戏连接
 */
export class NetworkClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.selfId = null;
    this.world = null;
    this.seq = 0;
    this.onWelcome = null;
    this.onSnapshot = null;
    this.onDisconnect = null;
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

  /** 建立 WebSocket 游戏连接 */
  connect(token) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      ws.onclose = () => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'welcome':
            this.selfId = msg.entityId;
            this.world = msg.world;
            this.welcome = msg; // 缓存，防止 handler 尚未挂载时丢失
            if (this.onWelcome) this.onWelcome(msg);
            break;
          case 'snapshot':
            if (this.onSnapshot) this.onSnapshot(msg);
            break;
          case 'error':
            console.error('[net]', msg.message);
            break;
        }
      };
    });
  }

  /** 发送输入（移动 + 跳跃） */
  sendInput(moveX, moveZ, jump) {
    if (!this.connected) return;
    this.ws.send(
      JSON.stringify({
        type: 'input',
        seq: ++this.seq,
        moveX,
        moveZ,
        jump,
      })
    );
  }

  close() {
    this.connected = false;
    if (this.ws) this.ws.close();
  }
}
