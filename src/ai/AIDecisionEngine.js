'use strict';

const { decidePreflop } = require('./PreflopRanges');
const { decidePostflop } = require('./PostflopHeuristic');

// 결정된 액션이 실제로 합법적인지 최종 방어. 불법이면 합리적인 액션으로 강등.
function sanitize(legal, decision) {
  let { actionType, amount } = decision;
  const { reason, meta, detail, situation, reads, readsRange, readsEffect } = decision;
  const original = actionType;

  if (actionType === 'raise' && !legal.canRaise) {
    actionType = legal.canCall ? 'call' : legal.canCheck ? 'check' : 'fold';
  }
  if (actionType === 'call' && !legal.canCall) {
    actionType = legal.canCheck ? 'check' : 'fold';
  }
  if (actionType === 'check' && !legal.canCheck) {
    actionType = legal.canCall ? 'call' : 'fold';
  }
  if (actionType === 'fold' && !legal.canFold) {
    // canFold가 false라는 건 무료로 체크 가능하다는 뜻이므로 체크로 대체한다.
    actionType = 'check';
  }
  if (actionType === 'raise' && (amount == null || Number.isNaN(amount))) {
    amount = legal.minRaiseTo;
  }
  let outReason = reason;
  if (outReason && original !== actionType) {
    const ko = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', allin: '올인' };
    outReason += ` (원래는 ${ko[original] || original}하려 했지만 규칙상 할 수 없어 ${ko[actionType] || actionType}(으)로 바뀌었어요.)`;
  }
  const out = { actionType, amount };
  if (outReason) out.reason = outReason;
  if (situation) out.situation = situation;
  if (detail) out.detail = detail;
  if (reads) out.reads = reads;
  if (readsRange) out.readsRange = readsRange;
  if (readsEffect) out.readsEffect = readsEffect;
  if (meta) out.meta = meta;
  return out;
}

/**
 * 좌석의 AI 액션을 결정한다.
 * @param {import('../game/GameEngine').GameEngine} engine
 * @param {number} seatIndex
 * @param {object} [opts] { skillLevel, rng, opponentModel } (예전의 mistakeRate는 skillLevel에 통합됨)
 * @returns {{ actionType: string, amount?: number, reason?: string, meta?: object }}
 */
function decideAction(engine, seatIndex, opts = {}) {
  const legal = engine.getLegalActions(seatIndex);
  if (!legal) throw new Error('지금은 이 좌석의 차례가 아닙니다');

  const decision =
    engine.street === 'preflop'
      ? decidePreflop(engine, seatIndex, legal, opts)
      : decidePostflop(engine, seatIndex, legal, opts);

  return sanitize(legal, decision);
}

module.exports = { decideAction, sanitize };
