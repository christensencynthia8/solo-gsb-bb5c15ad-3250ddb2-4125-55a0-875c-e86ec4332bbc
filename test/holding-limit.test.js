'use strict';

/* 人员同时持有上限排查引擎单元测试：node test/holding-limit.test.js */

const assert = require('assert');
const { checkHoldingLimit, SEGMENT_STATUS } = require('../src/holding-limit');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 多道具叠加：列出超限连续分钟段、涉及道具与已知峰值
test('持有上限：多道具叠加，列出超限段与已知峰值', () => {
  const data = mkData(['甲', '乙', '丙'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', WAREHOUSE),
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 6, '张三', WAREHOUSE),
    rec('p2', 3, WAREHOUSE, '张三'), // 未归仓
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 10, 1);
  // 段：[0,0] 0；[1,1] {甲} 1；[2,2] {甲乙} 2；[3,4] {甲乙丙} 3；[5,5] {乙丙} 2；[6,10] {丙} 1
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount]),
    [[2, 2, 2], [3, 4, 3], [5, 5, 2]]
  );
  assert.deepStrictEqual(
    r.overLimitSegments[1].knownProps.map((p) => p.propName),
    ['甲', '乙', '丙']
  );
  assert.strictEqual(r.peak.knownPeak, 3);
  assert.deepStrictEqual(r.peak.segments, [{ startMinute: 3, endMinute: 4 }]);
  assert.strictEqual(r.undeterminableSegments.length, 0);
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.summary.overLimitCount, 3);
  assert.strictEqual(r.summary.knownPeak, 3);
});

// 2. 等于上限不算超限（严格超过才算）
test('持有上限：等于上限不算超限', () => {
  const data = mkData(['甲', '乙'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 2, WAREHOUSE, '张三'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 5, 2);
  assert.strictEqual(r.overLimitSegments.length, 0);
  assert.strictEqual(r.peak.knownPeak, 2);
  // 上限收紧到 1：第 2 分钟起确定持有 2 件，超限
  const r2 = checkHoldingLimit(data, '张三', 0, 5, 1);
  assert.deepStrictEqual(
    r2.overLimitSegments.map((s) => [s.startMinute, s.endMinute]),
    [[2, 5]]
  );
});

// 3. 同分钟链式交接按最终持有人判定
test('持有上限：同分钟链式交接按最终持有人判定', () => {
  const data = mkData(['甲'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 2, '张三', '李四'), // 同分钟链式，最终李四
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 5, 0);
  // 第 2 分钟全部交接完成后持有人为李四，张三全程不持有
  assert.strictEqual(r.overLimitSegments.length, 0);
  assert.strictEqual(r.peak.knownPeak, 0);
  // 李四自第 2 分钟起持有
  const r2 = checkHoldingLimit(data, '李四', 0, 5, 0);
  assert.deepStrictEqual(
    r2.overLimitSegments.map((s) => [s.startMinute, s.endMinute]),
    [[2, 5]]
  );
});

// 4. 冲突道具自冲突分钟起视为未知（歧义冲突）
test('持有上限：冲突道具自冲突分钟起视为未知', () => {
  const data = mkData(['甲'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', '王五'), // 歧义：同一分钟两条可接续
    rec('p0', 4, '张三', '赵六'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 6, 0);
  // [1,3] 确定持有 1 件，超过上限 0：确定超限
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount]),
    [[1, 3, 1]]
  );
  // [4,6] 冲突，含未知道具：无法判定
  assert.strictEqual(r.undeterminableSegments.length, 1);
  const u = r.undeterminableSegments[0];
  assert.strictEqual(u.startMinute, 4);
  assert.strictEqual(u.endMinute, 6);
  assert.strictEqual(u.knownCount, 0);
  assert.strictEqual(u.maxPossibleCount, 1);
  assert.deepStrictEqual(u.unknownProps.map((p) => p.propName), ['甲']);
  assert.strictEqual(u.unknownProps[0].conflictMinute, 4);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].conflictMinute, 4);
  assert.strictEqual(r.conflicts[0].conflictType, 'AMBIGUOUS');
});

// 5. 已知持有数已超上限：含未知仍判确定超限
test('持有上限：已知持有数已超上限，含未知仍判确定超限', () => {
  const data = mkData(['甲', '乙'], [
    rec('p0', 1, WAREHOUSE, '张三'), // 甲未归仓
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 5, '张三', '王五'), // 歧义 @5
    rec('p1', 5, '张三', '赵六'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 6, 1);
  // [2,4] 确定持有 2 件 > 1：确定超限（即使 [5,6] 起乙未知）
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownCount]),
    [[2, 4, 2]]
  );
  // [5,6] 确定持有 1 件（甲），乙未知：1+1=2 > 1 → 无法判定
  assert.strictEqual(r.undeterminableSegments.length, 1);
  assert.strictEqual(r.undeterminableSegments[0].startMinute, 5);
  assert.strictEqual(r.undeterminableSegments[0].endMinute, 6);
  assert.strictEqual(r.undeterminableSegments[0].maxPossibleCount, 2);
});

// 6. 已知 + 未知仍不超上限：确定不超限（不列出）
test('持有上限：已知 + 未知仍不超上限，确定不超限（不列出）', () => {
  const data = mkData(['甲', '乙'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 5, '张三', '王五'), // 歧义 @5
    rec('p1', 5, '张三', '赵六'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 6, 2);
  // [2,4] 2 件等于上限；[5,6] 1 件 + 1 未知 = 2 件仍不超上限
  assert.strictEqual(r.overLimitSegments.length, 0);
  assert.strictEqual(r.undeterminableSegments.length, 0);
  assert.strictEqual(r.peak.knownPeak, 2);
});

// 7. 窗口外的后续冲突不影响结果
test('持有上限：窗口外的后续冲突不影响结果', () => {
  const data = mkData(['甲'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 8, '张三', '王五'), // 歧义 @8（窗口外）
    rec('p0', 8, '张三', '赵六'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 5, 0);
  // 冲突 @8 > end=5，不参与：[1,5] 确定持有 1 件，确定超限
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute]),
    [[1, 5]]
  );
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.undeterminableSegments.length, 0);
});

// 8. 起点前冲突：整个窗口视为未知
test('持有上限：起点前冲突，整个窗口视为未知', () => {
  const data = mkData(['甲'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '王五'), // 歧义 @3（起点前）
    rec('p0', 3, '张三', '赵六'),
  ]);
  const r = checkHoldingLimit(data, '张三', 4, 6, 0);
  // 冲突 @3 < start=4：整个 [4,6] 未知
  assert.strictEqual(r.overLimitSegments.length, 0);
  assert.strictEqual(r.undeterminableSegments.length, 1);
  assert.deepStrictEqual(
    [r.undeterminableSegments[0].startMinute, r.undeterminableSegments[0].endMinute],
    [4, 6]
  );
  assert.strictEqual(r.conflicts.length, 1);
});

// 9. 全程无持有：无超限且峰值 0
test('持有上限：全程无持有，无超限且峰值 0', () => {
  const data = mkData(['甲'], [
    rec('p0', 1, WAREHOUSE, '李四'),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 5, 1);
  assert.strictEqual(r.overLimitSegments.length, 0);
  assert.strictEqual(r.undeterminableSegments.length, 0);
  assert.strictEqual(r.peak.knownPeak, 0);
  assert.deepStrictEqual(r.peak.segments, []);
});

// 10. 仓库作为查询对象（在仓持有）
test('持有上限：仓库作为查询对象（在仓持有）', () => {
  const data = mkData(['甲'], [
    rec('p0', 2, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', WAREHOUSE),
  ]);
  const r = checkHoldingLimit(data, WAREHOUSE, 0, 6, 0);
  // [0,1] 仓库持有；[2,4] 张三持有；[5,6] 仓库持有
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute]),
    [[0, 1], [5, 6]]
  );
});

// 11. 无关交接不拆段，相邻同状态段合并
test('持有上限：无关交接不拆段，相邻同状态段合并', () => {
  const data = mkData(['甲', '乙'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 4, '张三', '李四'),
    rec('p1', 2, WAREHOUSE, '王五'), // 与张三无关
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 6, 0);
  // [1,3] 张三持有甲（乙的交接与张三无关，不拆段）
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute, s.knownProps.map((p) => p.propName)]),
    [[1, 3, ['甲']]]
  );
});

// 12. 已知峰值取确定持有数最大值，多段并列
test('持有上限：已知峰值取确定持有数最大值，多段并列', () => {
  const data = mkData(['甲', '乙'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', WAREHOUSE),
    rec('p0', 5, WAREHOUSE, '张三'),
    rec('p0', 7, '张三', WAREHOUSE),
    rec('p1', 2, WAREHOUSE, '张三'),
    rec('p1', 4, '张三', WAREHOUSE),
    rec('p1', 6, WAREHOUSE, '张三'),
    rec('p1', 8, '张三', WAREHOUSE),
  ]);
  const r = checkHoldingLimit(data, '张三', 0, 9, 0);
  // 段：[0,0] 0；[1,1] {甲} 1；[2,2] {甲乙} 2；[3,3] {乙} 1；[4,4] 0；
  //     [5,5] {甲} 1；[6,6] {甲乙} 2；[7,7] {乙} 1；[8,9] 0
  assert.strictEqual(r.peak.knownPeak, 2);
  assert.deepStrictEqual(r.peak.segments, [
    { startMinute: 2, endMinute: 2 },
    { startMinute: 6, endMinute: 6 },
  ]);
});

// 13. 断链冲突同样自冲突分钟起视为未知
test('持有上限：断链冲突自冲突分钟起视为未知', () => {
  const data = mkData(['甲'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'), // 断链：当前为王五
    rec('p0', 9, '钱七', WAREHOUSE),
  ]);
  const r = checkHoldingLimit(data, '王五', 0, 12, 0);
  // [2,3] 确定持有 1 件，确定超限；[4,12] 未知，无法判定
  assert.deepStrictEqual(
    r.overLimitSegments.map((s) => [s.startMinute, s.endMinute]),
    [[2, 3]]
  );
  assert.strictEqual(r.undeterminableSegments.length, 1);
  assert.strictEqual(r.undeterminableSegments[0].startMinute, 4);
  assert.strictEqual(r.undeterminableSegments[0].endMinute, 12);
  assert.strictEqual(r.conflicts[0].conflictType, 'BROKEN');
});

console.log(`\n全部 ${passed} 个持有上限排查引擎测试通过 ✔`);
