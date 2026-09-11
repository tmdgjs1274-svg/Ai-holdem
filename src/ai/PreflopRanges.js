'use strict';

const { chenScore } = require('./Equity');
const { roundRaiseTo } = require('./util');
const { getPositionCategory } = require('../game/Position');

// 9-max 기준 포지션별 오픈레이즈 최소 점수 (풀링 기준선)
const BASE_OPEN_THRESHOLD = {
  UTG: 8,
  MP: 7,
  CO: 6,
  BTN: 4.5,
  SB: 5.5,
  BB: 6, // BB 앞에 리밈만 있고 레이즈가 없을 때 이소레이즈 기준
};

// 테이블 인원수가 적을수록 레인지를 넓힌다 (9명 기준 대비 보정치)
function loosenForTableSize(threshold, numActive) {
  const delta = (9 - numActive) * 0.35;
  return Math.max(threshold - delta, -1);
}

// 상대적으로 몇 번의 레이즈가 있었는지 베팅 사이즈로 근사 추정
function estimateRaiseLevel(engine) {
  const bb = engine.bigBlind;
  if (engine.currentBet <= bb) return 0;
  if (engine.currentBet <= bb * 3.5) return 1;
  if (engine.currentBet <= bb * 9) return 2;
  return 3;
}

/**
 * 프리플랍 의사결정에 필요한 컨텍스트를 계산.
 */
function buildPreflopContext(engine, seatIndex) {
  const order = engine.handSeatsInOrder();
  const numActive = order.length;
  const position = getPositionCategory(order, seatIndex);
  const seat = engine.seats[seatIndex];
  const hs = engine.hs[seatIndex];
  const score = chenScore(hs.holeCards[0], hs.holeCards[1]);
  const effectiveStackBb = seat.stack / engine.bigBlind;
  const raiseLevel = estimateRaiseLevel(engine);
  const openThreshold = loosenForTableSize(BASE_OPEN_THRESHOLD[position] ?? 7, numActive);
  return { order, numActive, position, score, effectiveStackBb, raiseLevel, openThreshold };
}

/**
 * 숏스택 푸시/폴드 구간 여부와 셔브 임계값.
 * 스택이 짧을수록, 포지션이 늦을수록 셔브 범위가 넓어진다.
 */
function pushFoldThreshold(position, stackBb) {
  const posAdj = { UTG: 1.5, MP: 0.5, CO: -1, BTN: -2.5, SB: -1.5, BB: -1 }[position] ?? 0;
  // 15bb에서 기준 7점, 스택이 줄어들수록 완만히 낮아짐 (5bb 근처에서 매우 넓어짐)
  const base = 7 + posAdj - (15 - stackBb) * 0.35;
  return Math.max(base, 0.5);
}

function sizePreflopRaise(engine, legal, ctx) {
  const bb = engine.bigBlind;
  let raiseTo;
  if (ctx.raiseLevel === 0) {
    raiseTo = engine.currentBet + bb * 2.2;
  } else {
    raiseTo = engine.currentBet * 3;
  }
  raiseTo = Math.round(raiseTo / bb) * bb;
  raiseTo = Math.max(legal.minRaiseTo, Math.min(raiseTo, legal.maxRaiseTo));
  return roundRaiseTo(raiseTo, legal, 100); // 100원 단위로 보기 좋게 반올림
}

/**
 * 프리플랍 액션 결정. 반환: { actionType, amount? }
 */
function decidePreflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const mistakeRate = opts.mistakeRate != null ? opts.mistakeRate : 0.08;
  const ctx = buildPreflopContext(engine, seatIndex);
  let score = ctx.score;
  if (rng() < mistakeRate) score += (rng() - 0.5) * 4; // 사람같은 실수: 핸드 강도 인식 오차

  // raiseLevel===0: 아직 아무도 빅블라인드 이상으로 레이즈하지 않은 "오픈되지 않은" 팟.
  // (BB를 완성하기 위해 콜해야 하는 금액이 있어도 이는 "실제 레이즈에 대응"이 아니라 "오픈 여부 결정"임)
  const unopenedPot = ctx.raiseLevel === 0;

  if (ctx.effectiveStackBb <= 15) {
    let shoveThresh = pushFoldThreshold(ctx.position, ctx.effectiveStackBb);
    if (!unopenedPot) shoveThresh += 1 + ctx.raiseLevel;
    if (score >= shoveThresh) {
      if (legal.canRaise) return { actionType: 'allin' };
      return { actionType: legal.canCall ? 'call' : 'check' };
    }
    if (unopenedPot && legal.canCheck) return { actionType: 'check' };
    return { actionType: 'fold' };
  }

  const openThresh = ctx.openThreshold + ctx.raiseLevel * 2.2;
  const raiseThresh = openThresh + 3.5;
  const callThresh = openThresh - 1.7;

  if (unopenedPot) {
    // 오픈 여부 결정: 레이즈-오어-폴드 원칙 (림프는 최소화, 가끔 사람처럼 림프)
    if (score >= openThresh) {
      if (legal.canRaise) return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx) };
      if (legal.canCheck) return { actionType: 'check' };
      return { actionType: 'call' };
    }
    if (legal.canCheck) return { actionType: 'check' }; // BB 무료 옵션
    if (legal.canCall && rng() < 0.06) return { actionType: 'call' }; // 사람같은 가끔의 림프
    return { actionType: 'fold' };
  }

  // 실제 레이즈(또는 3벳 이상)에 대응하는 상황
  const bluffWindow = score >= callThresh - 1 && score < openThresh && ['BTN', 'CO', 'SB'].includes(ctx.position);
  const bluffRoll = rng() < 0.12 && ctx.numActive <= 5;

  if (score >= raiseThresh && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx) };
  }
  if (bluffWindow && bluffRoll && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx) };
  }
  if (score >= callThresh) {
    if (legal.canCheck) return { actionType: 'check' };
    if (legal.canCall) return { actionType: 'call' };
    return { actionType: 'fold' };
  }
  if (legal.canCall && rng() < 0.05) return { actionType: 'call' }; // 가끔 브러프캐치성 콜(실수 포함)
  return { actionType: legal.canCheck ? 'check' : 'fold' };
}

module.exports = {
  getPositionCategory,
  buildPreflopContext,
  pushFoldThreshold,
  decidePreflop,
  sizePreflopRaise,
  BASE_OPEN_THRESHOLD,
};
