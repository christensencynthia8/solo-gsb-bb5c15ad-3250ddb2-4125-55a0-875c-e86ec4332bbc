'use strict';

/* 人员同时持有上限排查接口集成测试：node test/holding-limit-api.test.js
 * 使用独立临时数据文件，真实启动服务走 HTTP 全流程。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tmp-holding-limit-api-store.json');
process.env.DATA_FILE = DATA_FILE;

for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 不存在则忽略 */ }
}

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(url, options = {}) {
  const res = await fetch(`${base}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body }
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 初始演示数据：
  // 青龙剑：仓库@0→张三@3→李四@8→张三@12→仓库
  // 折扇：仓库@1→张三，第5分歧义冲突（张三→王五 / 张三→赵六）
  // 宫灯：仓库@2→王五，第4分断链冲突（李四→钱七），钱七@9→仓库
  // 御印：仓库@1→周八，周八@6→孙七
  const state0 = (await api('/api/state')).body;
  const rev0 = state0.rev;
  const count0 = state0.records.length;

  // 1. 张三 [0,12] 上限 1：确定超限段 / 无法判定段 / 峰值 / 冲突完整返回
  await test('持有上限：超限段 / 无法判定 / 峰值 / 冲突完整返回', async () => {
    const res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=1');
    assert.strictEqual(res.status, 200);
    const r = res.body;
    assert.strictEqual(r.person, '张三');
    assert.strictEqual(r.startMinute, 0);
    assert.strictEqual(r.endMinute, 12);
    assert.strictEqual(r.limit, 1);
    assert.strictEqual(r.warehouse, '仓库');

    // 确定超限：[1,2] 青龙剑+折扇 2 件
    assert.deepStrictEqual(
      r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount]),
      [[1, 2, 2]]
    );
    assert.deepStrictEqual(
      r.overLimitSegments[0].knownProps.map((p) => p.propName),
      ['青龙剑', '折扇']
    );

    // 无法判定：[4,4]（折扇+宫灯未知）、[5,7]（折扇宫灯未知）、
    //           [8,11]（青龙剑+折扇宫灯未知）、[12,12]（折扇宫灯未知）
    assert.deepStrictEqual(
      r.undeterminableSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount, s.maxPossibleCount]),
      [[4, 4, 1, 2], [5, 7, 0, 2], [8, 11, 1, 3], [12, 12, 0, 2]]
    );
    assert.deepStrictEqual(
      r.undeterminableSegments[0].unknownProps.map((p) => p.propName),
      ['宫灯']
    );
    assert.deepStrictEqual(
      r.undeterminableSegments[1].unknownProps.map((p) => p.propName),
      ['折扇', '宫灯']
    );

    // 已知峰值 2，出现于 [1,2]
    assert.strictEqual(r.peak.knownPeak, 2);
    assert.deepStrictEqual(r.peak.segments, [{ startMinute: 1, endMinute: 2 }]);

    // 冲突：宫灯@4 断链、折扇@5 歧义
    assert.deepStrictEqual(
      r.conflicts.map((c) => [c.propName, c.conflictMinute, c.conflictType]),
      [['宫灯', 4, 'BROKEN'], ['折扇', 5, 'AMBIGUOUS']]
    );

    assert.strictEqual(r.summary.overLimitCount, 1);
    assert.strictEqual(r.summary.undeterminableCount, 4);
    assert.strictEqual(r.summary.knownPeak, 2);
    assert.strictEqual(r.summary.conflictPropCount, 2);
  });

  // 2. 上限 2：无确定超限；[8,11] 仍无法判定（1+2=3 > 2）
  await test('持有上限：上限放宽后仅保留无法判定段', async () => {
    const r = (await api('/api/holding-limit?person=张三&start=0&end=12&limit=2')).body;
    assert.strictEqual(r.overLimitSegments.length, 0);
    assert.deepStrictEqual(
      r.undeterminableSegments.map((s) => [s.startMinute, s.endMinute]),
      [[8, 11]]
    );
    assert.strictEqual(r.peak.knownPeak, 2);
  });

  // 3. 窗口外冲突不影响：end=3 时第 4/5 分冲突不参与
  await test('持有上限：窗口外冲突不影响结果', async () => {
    const r = (await api('/api/holding-limit?person=张三&start=0&end=3&limit=0')).body;
    // [0,0] 青龙剑 1 件；[1,2] 青龙剑+折扇 2 件；[3,3] 折扇 1 件
    assert.deepStrictEqual(
      r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount]),
      [[0, 0, 1], [1, 2, 2], [3, 3, 1]]
    );
    assert.strictEqual(r.conflicts.length, 0);
    assert.strictEqual(r.undeterminableSegments.length, 0);
  });

  // 4. 只读：查询不改写数据（版本号与记录数不变）
  await test('持有上限：查询只读，数据版本与记录数不变', async () => {
    await api('/api/holding-limit?person=张三&start=0&end=12&limit=1');
    await api('/api/holding-limit?person=仓库&start=0&end=12&limit=0');
    const after = (await api('/api/state')).body;
    assert.strictEqual(after.rev, rev0);
    assert.strictEqual(after.records.length, count0);
  });

  // 5. 参数校验：缺参数 / 负数 / 小数 / 非数字 / 起止颠倒均 400
  await test('持有上限：参数校验 400', async () => {
    let res = await api('/api/holding-limit?start=0&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=12');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=-1&end=12&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=1.5&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=5&end=3&limit=1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=-1');
    assert.strictEqual(res.status, 400);
    res = await api('/api/holding-limit?person=张三&start=0&end=12&limit=x');
    assert.strictEqual(res.status, 400);
    assert.ok(/持有件数上限/.test(res.body.error));
  });

  server.close();
  for (const f of [DATA_FILE, `${DATA_FILE}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log(`\n全部 ${passed} 个持有上限排查接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
