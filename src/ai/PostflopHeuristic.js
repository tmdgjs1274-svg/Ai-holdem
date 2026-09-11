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
 */
function decidePostflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const mistakeRate = opts.mistakeRate != null ? opts.mistakeRate : 0.08;
  const hs = engine.hs[seatIndex];

  const numOpponents = engine.activePlayerSeats().filter((i) => i !== seatIndex).length;
  const iterations = Math.max(60, 220 - numOpponents * 18);
  const rawEquity = estimateEquity(hs.holeCards, engine.board, numOpponents, rng, iterations);

  let noise = 0;
  if (rng() < mistakeRate) noise = (rng() - 0.5) * 0.3; // 사람같은 실수: 이퀴티 오판
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
