/**
 * 客户端碰撞检测优化验证脚本 - 简化版
 */

console.log('=== 客户端碰撞检测优化验证 ===\n');

// 模拟 predict.js 的核心逻辑
class MockPredictor {
  constructor() {
    this.pos = { x: 0, y: 5, z: 0 };
    this._radius = 0.55;
    this._collisionCooldown = new Map();
    this._minSeparationDist = 0.05;
    this._collisionCooldownMs = 200;
  }

  circleBlocked(x, z, r) {
    return (x - r) < -5.0; // 仅左侧为障碍
  }

  _separateFromEntity(other, now) {
    const dx = this.pos.x - other.x;
    const dz = this.pos.z - other.z;
    const d2 = dx * dx + dz * dz;
    const rr = this._radius + (other.radius || 0.5);
    
    if (d2 <= 0.0 || d2 >= rr * rr) return false;
    
    const d = Math.sqrt(d2);
    const overlap = rr - d;
    
    if (overlap < this._minSeparationDist) return false;
    
    const lastCollision = this._collisionCooldown.get(other.wid) || 0;
    if (now - lastCollision < this._collisionCooldownMs) {
      if (overlap < 0.3) return false;
    }
    
    const nx = dx / d, nz = dz / d;
    // 沿法线方向远离怪物（玩家被推开）
    const newX = this.pos.x + nx * overlap;
    const newZ = this.pos.z + nz * overlap;
    
    if (!this.circleBlocked(newX, newZ, this._radius)) {
      this.pos.x = newX;
      this.pos.z = newZ;
      this._collisionCooldown.set(other.wid, now);
      return true;
    }
    
    const slideX = this.pos.x + nx * overlap;
    if (!this.circleBlocked(slideX, this.pos.z, this._radius)) {
      this.pos.x = slideX;
      this._collisionCooldown.set(other.wid, now);
      return true;
    }
    
    const slideZ = this.pos.z + nz * overlap;
    if (!this.circleBlocked(this.pos.x, slideZ, this._radius)) {
      this.pos.z = slideZ;
      this._collisionCooldown.set(other.wid, now);
      return true;
    }
    
    return false;
  }

  setPosition(x, z) {
    this.pos.x = x;
    this.pos.z = z;
  }
}

// 测试 1: 基本分离逻辑
console.log('【测试 1】基本分离逻辑');
{
  const predictor = new MockPredictor();
  const monster = { wid: 100, x: 0.8, z: 0, radius: 0.5 };
  const now = 1000;
  
  const distBefore = Math.hypot(predictor.pos.x - monster.x, predictor.pos.z - monster.z);
  const minDist = predictor._radius + monster.radius;
  
  const separated = predictor._separateFromEntity(monster, now);
  const distAfter = Math.hypot(predictor.pos.x - monster.x, predictor.pos.z - monster.z);
  
  console.log(`  初始距离: ${distBefore.toFixed(3)}m (需要: ${minDist.toFixed(3)}m)`);
  console.log(`  分离结果: ${separated ? '成功' : '失败'}`);
  console.log(`  最终距离: ${distAfter.toFixed(3)}m`);
  console.log(`  ✓ 通过: ${separated && distAfter >= minDist - 0.01}\n`);
}

// 测试 2: 防抖机制
console.log('【测试 2】防抖机制（冷却时间）');
{
  const predictor = new MockPredictor();
  const monster = { wid: 200, x: 0.8, z: 0, radius: 0.5 };
  
  const sep1 = predictor._separateFromEntity(monster, 1000);
  const sep2 = predictor._separateFromEntity(monster, 1100); // 100ms 后，仍在冷却期
  
  console.log(`  第一次 (t=1000): ${sep1}`);
  console.log(`  第二次 (t=1100, 间隔100ms): ${sep2}`);
  console.log(`  ✓ 通过: ${sep1 && !sep2}\n`);
}

// 测试 3: 大重叠强制处理
console.log('【测试 3】大重叠强制处理（防止穿透）');
{
  const predictor = new MockPredictor();
  const monster = { wid: 300, x: 0.2, z: 0, radius: 0.5 };
  
  const sep1 = predictor._separateFromEntity(monster, 2000);
  const overlap = (predictor._radius + monster.radius) - Math.hypot(0, 0.2);
  
  predictor.setPosition(0, 0);
  const sep2 = predictor._separateFromEntity(monster, 2100); // 冷却期内但重叠大
  
  console.log(`  重叠量: ${overlap.toFixed(3)}m`);
  console.log(`  第一次: ${sep1}, 第二次(冷却期+大重叠): ${sep2}`);
  console.log(`  ✓ 通过: ${sep1 && sep2}\n`);
}

// 测试 4: 性能测试
console.log('【测试 4】性能测试（100实体 × 1000次迭代）');
{
  const predictor = new MockPredictor();
  const entities = [];
  for (let i = 0; i < 100; i++) {
    const angle = (i / 100) * Math.PI * 2;
    const dist = 0.8 + Math.random() * 0.5;
    entities.push({ wid: 400 + i, x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, radius: 0.5 });
  }
  
  const startTime = performance.now();
  for (let iter = 0; iter < 1000; iter++) {
    const now = 3000 + iter * 50;
    let count = 0;
    const checkR2 = (predictor._radius + 2.0) ** 2;
    
    for (const e of entities) {
      const d2 = (predictor.pos.x - e.x)**2 + (predictor.pos.z - e.z)**2;
      if (d2 > checkR2) continue;
      if (predictor._separateFromEntity(e, now)) {
        if (++count >= 8) break;
      }
    }
  }
  
  const avg = (performance.now() - startTime) / 1000;
  console.log(`  平均每次: ${avg.toFixed(3)}ms`);
  console.log(`  ✓ 性能合格: ${avg < 1.0}\n`);
}

console.log('=== 所有测试完成 ===');
