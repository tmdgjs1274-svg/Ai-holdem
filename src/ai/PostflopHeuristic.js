'use strict';

const { estimateEquity } = require('./Equity');
const { roundRaiseTo } = require('./util');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sizeBet(engine, legal, fraction) {
  const pot = Math.max(engine.potNow(), engine.bigBlind);
  let raiseTo;
  if (engine.currentBet === 0) {
    raiseTo = Math.round(pot * fraction);
    raiseTo = Math.max(raiseTo, legal.minRaiseTo);
  } else {
    const potAfterCall = pot + legal.callAmount;
    const raiseIncrement = Math.round(potAfterCall * fraction);
    raiseTo = engine.currentBet + Math.max(raiseIncrement, legal.minRaiseTo - engine.currentBet);
  }
  raiseTo = clamp(raiseTo, legal.minRaiseTo, legal.maxRaiseTo);
  return roundRaiseTo(raiseTo, legal, 100); // 100원 단위로 보기 좋게 반올림
}

/**
 * Postflop(플랍/턴/리버) 액션 결정. 이퀴티 추정 + 팟오즈 + 빈도 기반 믹스전략.
 * 반환: { actionType, amount? }
 *
 * 난이도는 두 개의 독립된 축으로 조절한다.
 *  - skillLevel(0~100): 기본 판단 정밀도. 매 판단마다 항상 적용되는 "실력 잡음"의 크기와,
 *    이퀴티 추정에 쓰는 몬테카를로 반복 횟수(=추정 노이즈)를 함께 결정한다. 낮을수록 항상
 *    어느 정도 부정확하게 판단하고(초보자처럼 손패 가치를 오판), 100이면 반복 횟수가 최대치라
 *    이퀴티 추정 자체의 통계적 잡음도 최소화된다.
 *  - mistakeRate(0~1): skillLevel과 무관하게, 드물게 "확 틀리는" 큰 실수(틸트/순간 방심)를
 *    확률적으로 섞어 넣는 축. 실력이 높아도 가끔 실수는 할 수 있다는 걸 표현한다.
 */
function decidePostflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const mistakeRate = opts.mistakeRate != null ? opts.mistakeRate : 0.08;
  const skill = clamp(opts.skillLevel != null ? opts.skillLevel : 75, 0, 100);
  const hs = engine.hs[seatIndex];

  const numOpponents = engine.activePlayerSeats().filter((i) => i !== seatIndex).length;
  // skillLevel이 높을수록 몬테카를로 반복 횟수를 늘려 이퀴티 추정의 통계적 잡음을 줄인다.
  // (기존에는 상대 수와만 연동되어 최대 220회였는데, mistakeRate를 0으로 둬도 이 추정 잡음
  //  자체가 "실수처럼 보이는 오판"의 원인이 될 수 있었다.)
  const baseIterations = Math.round(120 + (skill / 100) * 480); // 120~600
  const iterations = Math.max(70, baseIterations - numOpponents * 20);
  const rawEquity = estimateEquity(hs.holeCards, engine.board, numOpponents, rng, iterations);

  let noise = 0;
  // 실력과 무관하게 드물게 섞이는 큰 실수(이퀴티 오판)
  if (rng() < mistakeRate) noise += (rng() - 0.5) * 0.3;
  // 실력이 낮을수록 매 판단마다 항상 섞이는 잔잡음(0=아주 부정확, 100=거의 없음)
  noise += (rng() - 0.5) * (1 - skill / 100) * 0.22;
  const equity = clamp(rawEquity + noise, 0, 1);

  const pot = engine.potNow();

  if (legal.callAmount === 0) {
    // 베팅 여부 결정 (체크 or 베팅)
    if (equity > 0.68) {
      if (legal.canRaise && rng() < 0.88) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, 0.62 + rng() * 0.18) };
      }
    } else if (equity > 0.45) {
      if (legal.canRaise && rng() < 0.4) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, 0.45 + rng() * 0.15) };
      }
    } else {
      const bluffFreq = Math.max(0.05, 0.28 / (numOpponents + 1));
      if (legal.canRaise && rng() < bluffFreq) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, 0.55 + rng() * 0.2) };
      }
    }
    return { actionType: 'check' };
  }

  // 상대 베팅에 대응
  const requiredEquity = legal.callAmount / (pot + legal.callAmount);

  if (equity > requiredEquity + 0.22) {
    if (legal.canRaise && rng() < 0.55) {
      return { actionType: 'raise', amount: sizeBet(engine, legal, 0.65 + rng() * 0.2) };
    }
    return legal.canCall ? { actionType: 'call' } : { actionType: 'check' };
  }
  if (equity > requiredEquity) {
    return legal.canCall ? { actionType: 'call' } : { actionType: 'check' };
  }

  const gap = requiredEquity - equity;
  if (gap < 0.08 && legal.canCall && rng() < 0.3) {
    return { actionType: 'call' }; // 브러프캐치 믹스
  }
  if (equity > 0.3 && equity < 0.5 && legal.canRaise && rng() < 0.08) {
    return { actionType: 'raise', amount: sizeBet(engine, legal, 0.6) }; // 세미블러프
  }
  return { actionType: legal.canCheck ? 'check' : 'fold' };
}

module.exports = { decidePostflop, sizeBet };
