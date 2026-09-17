'use strict';

const { chenScore } = require('./Equity');
const { roundRaiseTo, quirkFactor, bigBlunderChance, mixFrequency } = require('./util');
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

// 포지션별 기본 오픈레이즈 배수(빅블라인드 기준). 늦은 포지션일수록 조금 더 작게,
// 이른 포지션일수록 조금 더 크게 여는 실제 사람들의 경향을 대략 반영한다.
const OPEN_RAISE_BASE_MULT = { UTG: 3, MP: 2.7, CO: 2.4, BTN: 2.2, SB: 3, BB: 2.5 };

function sizePreflopRaise(engine, legal, ctx, rng) {
  const bb = engine.bigBlind;
  const rand = rng || Math.random;
  let raiseTo;
  if (ctx.raiseLevel === 0) {
    // 예전에는 항상 정확히 bb의 정수배로 반올림해서 사실상 매번 3bb로 고정되어 버렸다.
    // 2~3bb 사이에서 포지션에 따라, 그리고 약간의 무작위성으로 자연스럽게 오픈 사이즈가
    // 달라지도록 한다(정수 bb배로 딱 떨어뜨리지 않고 100원 단위로만 반올림).
    const baseMult = OPEN_RAISE_BASE_MULT[ctx.position] ?? 2.5;
    const jitter = (rand() - 0.5) * 0.6; // ±0.3bb
    const mult = Math.max(2, Math.min(3, baseMult + jitter));
    raiseTo = engine.currentBet + bb * (mult - 1);
  } else {
    raiseTo = engine.currentBet * 3;
  }
  raiseTo = Math.max(legal.minRaiseTo, Math.min(raiseTo, legal.maxRaiseTo));
  return roundRaiseTo(raiseTo, legal, 100); // 100원 단위로 보기 좋게 반올림
}

/**
 * 프리플랍 액션 결정. 반환: { actionType, amount? }
 *
 * 예전에는 skillLevel(항상 적용되는 판단 잡음)과 mistakeRate(드문 큰 실수)를 독립된 축으로
 * 따로 뒀지만, "실력을 100%로 올려도 mistakeRate 축이 남아있어 여전히 가끔 이상한 플레이가
 * 나온다"는 혼란이 있어 이제는 큰 실수도 skillLevel 하나에서 유도한다(util.bigBlunderChance -
 * skillLevel=100이면 정확히 0). skillLevel이 낮을수록 손패 강도 평가 자체가 흔들려서,
 * 오픈/콜/폴드 경계선에서 잘못된 선택을 더 자주 하게 된다.
 */
function decidePreflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const skill = Math.max(0, Math.min(100, opts.skillLevel != null ? opts.skillLevel : 75));
  const ctx = buildPreflopContext(engine, seatIndex);
  // skill===75(기존 기본값)에서는 1이라서 아래 고정 확률 잡버릇들의 세기가 그대로 유지되고,
  // skill=100이면 0이 되어 "실력 100%인데도 림프/3벳블러프가 나온다"는 문제가 사라진다.
  const quirk = quirkFactor(skill);
  // 3벳/4벳 블러프, 3벳에 대한 콜다운처럼 "실수"가 아니라 실력이 높아도 유지되는 밸런스
  // 전략 확률에는 mixFrequency를 쓴다(quirk와 달리 skill=100에서도 0으로 사라지지 않음).
  const mix = mixFrequency(skill);
  let score = ctx.score;
  if (rng() < bigBlunderChance(skill)) score += (rng() - 0.5) * 4; // 사람같은 실수: 핸드 강도 인식 오차(실력 100%면 0)
  score += (rng() - 0.5) * (1 - skill / 100) * 3; // 실력이 낮을수록 항상 섞이는 잔잡음

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
      if (legal.canRaise) return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng) };
      if (legal.canCheck) return { actionType: 'check' };
      return { actionType: 'call' };
    }
    if (legal.canCheck) return { actionType: 'check' }; // BB 무료 옵션
    if (legal.canCall && rng() < 0.06 * quirk) return { actionType: 'call' }; // 사람같은 가끔의 림프(실력 100%면 0)
    return { actionType: 'fold' };
  }

  // 실제 레이즈(또는 3벳 이상)에 대응하는 상황
  const bluffWindow = score >= callThresh - 1 && score < openThresh && ['BTN', 'CO', 'SB'].includes(ctx.position);
  // 3벳(이상) 블러프 확률. 0.12는 다소 잦다는 피드백을 반영해 0.09로 낮췄다. 이건 실수가 아니라
  // 밸런스를 위해 실력이 높아도 어느 정도 유지되어야 하는 확률이라 mixFrequency를 쓴다
  // (실력 100%에서도 완전히 0이 되지 않고 절반 정도(0.045)는 유지됨 - "실력 100%인데 3벳/4벳
  // 블러프를 전혀 안 한다"는 피드백을 반영).
  const bluffRoll = rng() < 0.09 * mix && ctx.numActive <= 5;

  if (score >= raiseThresh && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng) };
  }
  if (bluffWindow && bluffRoll && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng) };
  }
  if (score >= callThresh) {
    if (legal.canCheck) return { actionType: 'check' };
    if (legal.canCall) return { actionType: 'call' };
    return { actionType: 'fold' };
  }
  // callThresh에 살짝 못 미치지만 가끔 더 버텨보는 콜(3벳/4벳에 대한 콜다운 포함). 이것도
  // "실수"가 아니라 레인지를 너무 타이트하게 읽히지 않기 위한 밸런스 플레이라 mixFrequency를
  // 쓴다 - 실력 100%에서도 절반 정도(2.5%)는 유지되어 "3벳에 콜을 전혀 안 한다"는 문제를 줄인다.
  if (legal.canCall && rng() < 0.05 * mix) return { actionType: 'call' };
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
