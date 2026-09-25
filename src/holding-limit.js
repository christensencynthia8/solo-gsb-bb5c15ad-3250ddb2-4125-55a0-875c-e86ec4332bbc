'use strict';

/**
 * 人员同时持有上限排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入人员姓名、时间窗 [startMinute, endMinute]（起止分钟均包含）与持有件数上限，
 * 沿用现有「同分钟唯一交接链」规则逐件重放窗口内（截止 endMinute）的记录，
 * 以交接分钟为边界，合并各道具在「该分钟全部交接完成后」的持有人，
 * 得到该人员在窗口内每个连续分钟段的持有状态：
 *
 * - 确定持有：交接链可重放且该分钟全部交接完成后持有人为该人员；
 * - 未知：道具交接链在冲突分钟（含）起无法判定持有人，该道具自冲突分钟起视为未知；
 *   窗口结束分钟之后才发生的冲突不影响本次结果。
 *
 * 超限判定（不将未知计为零）：
 * - 确定持有数已严格超过上限：判为「确定超限」（即使有未知道具也不降级）；
 * - 确定持有数未超上限，但确定持有数 + 未知道具数超过上限（未知道具若均由
 *   该人持有会超限）：该时段标为「无法判定」；
 * - 确定持有数 + 未知道具数仍不超过上限：确定不超限（不列出）。
 *
 * 输出超过上限的连续分钟段（确定超限）、无法判定的连续分钟段、已知峰值
 * （窗口内确定持有数的最大值及其出现的分钟段）与各段涉及道具。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 段结论类型 */
const SEGMENT_STATUS = {
  OVER_LIMIT: 'OVER_LIMIT',     // 确定持有数已超过上限（确定超限）
  UNDETERMINED: 'UNDETERMINED', // 含未知道具，是否超限无法判定
};

function propRef(prop) {
  return { propId: prop.id, propName: prop.name };
}

/** 两个确定持有道具列表是否相同（按 propId 逐一比对，顺序一致） */
function sameProps(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

/** 两个未知道具列表是否相同（按 propId 与冲突分钟逐一比对） */
function sameUnknown(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].prop.id !== b[i].prop.id || a[i].conflictMinute !== b[i].conflictMinute) {
      return false;
    }
  }
  return true;
}

/**
 * 人员同时持有上限排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）
 * @param {number} limit 持有件数上限（非负整数，严格超过才算超限）
 * @returns {object}
 */
function checkHoldingLimit(data, person, startMinute, endMinute, limit) {
  const props = data.props || [];
  const records = data.records || [];

  // 逐件重放窗口内记录：更晚的记录与冲突不影响本次结果
  const propStates = [];
  const boundarySet = new Set([startMinute]);
  const conflicts = [];

  for (const prop of props) {
    const propRecords = sortRecords(
      records.filter((r) => r.propId === prop.id && Number(r.minute) <= endMinute)
    );
    const replay = replayPropRecords(propRecords);
    const conflictMinute = replay.ok ? null : replay.conflict.minute;
    propStates.push({ prop, chain: replay.chain, conflictMinute });

    for (const rec of replay.chain) {
      if (rec.minute > startMinute && rec.minute <= endMinute) boundarySet.add(rec.minute);
    }
    if (conflictMinute != null) {
      if (conflictMinute > startMinute && conflictMinute <= endMinute) {
        boundarySet.add(conflictMinute);
      }
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
        conflictRecordIds: replay.conflict.records || [],
      });
    }
  }

  const boundaries = [...boundarySet].sort((a, b) => a - b);

  // 逐段计算持有状态：段 [segStart, segEnd] 内每个分钟的
  // 「该分钟全部交接完成后」持有状态相同
  const rawSegments = boundaries.map((segStart, i) => {
    const segEnd = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : endMinute;
    const known = [];
    const unknown = [];
    for (const ps of propStates) {
      if (ps.conflictMinute != null && segStart >= ps.conflictMinute) {
        unknown.push({ prop: ps.prop, conflictMinute: ps.conflictMinute });
        continue;
      }
      let holder = WAREHOUSE;
      for (const rec of ps.chain) {
        if (rec.minute > segStart) break;
        holder = rec.to;
      }
      if (holder === person) known.push(ps.prop);
    }
    return { startMinute: segStart, endMinute: segEnd, known, unknown };
  });

  // 合并相邻同状态段（同一分钟交接的道具不涉及该人员时，相邻段状态相同）
  const segments = [];
  for (const seg of rawSegments) {
    const last = segments[segments.length - 1];
    if (last && sameProps(last.known, seg.known) && sameUnknown(last.unknown, seg.unknown)) {
      last.endMinute = seg.endMinute;
    } else {
      segments.push({ ...seg });
    }
  }

  // 分类：确定超限 / 无法判定；统计已知峰值
  const overLimitSegments = [];
  const undeterminableSegments = [];
  let knownPeak = 0;
  let peakSegments = [];

  for (const seg of segments) {
    const knownCount = seg.known.length;
    const unknownCount = seg.unknown.length;
    if (knownCount > knownPeak) {
      knownPeak = knownCount;
      peakSegments = [{ startMinute: seg.startMinute, endMinute: seg.endMinute }];
    } else if (knownCount === knownPeak && knownCount > 0) {
      peakSegments.push({ startMinute: seg.startMinute, endMinute: seg.endMinute });
    }

    const base = {
      startMinute: seg.startMinute,
      endMinute: seg.endMinute,
      knownCount,
      knownProps: seg.known.map(propRef),
      unknownProps: seg.unknown.map((u) => ({
        propId: u.prop.id,
        propName: u.prop.name,
        conflictMinute: u.conflictMinute,
      })),
    };

    if (knownCount > limit) {
      overLimitSegments.push({
        ...base,
        status: SEGMENT_STATUS.OVER_LIMIT,
        note:
          `第${seg.startMinute}–${seg.endMinute}分钟确定持有 ${knownCount} 件` +
          `（${seg.known.map((p) => p.name).join('、')}），超过上限 ${limit} 件` +
          (unknownCount > 0
            ? `；另有 ${unknownCount} 件道具自冲突分钟起持有人未知` +
              `（${seg.unknown.map((u) => u.prop.name).join('、')}），不影响超限结论`
            : ''),
      });
    } else if (unknownCount > 0 && knownCount + unknownCount > limit) {
      undeterminableSegments.push({
        ...base,
        status: SEGMENT_STATUS.UNDETERMINED,
        maxPossibleCount: knownCount + unknownCount,
        note:
          `第${seg.startMinute}–${seg.endMinute}分钟确定持有 ${knownCount} 件，` +
          `未超过上限 ${limit} 件；但 ${unknownCount} 件道具自冲突分钟起持有人未知` +
          `（${seg.unknown.map((u) => u.prop.name).join('、')}），` +
          `若均由该人持有将达 ${knownCount + unknownCount} 件并超过上限——` +
          `是否超限无法判定（未知道具不计为零）`,
      });
    }
  }

  conflicts.sort(
    (a, b) => a.conflictMinute - b.conflictMinute ||
      String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  return {
    person,
    startMinute,
    endMinute,
    limit,
    warehouse: WAREHOUSE,
    overLimitSegments,
    undeterminableSegments,
    peak: { knownPeak, segments: peakSegments },
    conflicts,
    summary: {
      totalProps: props.length,
      overLimitCount: overLimitSegments.length,
      undeterminableCount: undeterminableSegments.length,
      knownPeak,
      conflictPropCount: conflicts.length,
    },
  };
}

module.exports = {
  SEGMENT_STATUS,
  checkHoldingLimit,
};
