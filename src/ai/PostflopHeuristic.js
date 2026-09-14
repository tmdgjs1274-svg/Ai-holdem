'use strict';

const { estimateEquity } = require('./Equity');
const { roundRaiseTo, quirkFactor } = require('./util');
const { classifyBoardTexture } = require('./BoardTexture');
const { buildOpponentRangeFilters } = require('./RangeModel');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// skillLevel(0~100)에서 "고급 기능들을 얼마나 반영할지"의 공용 가중치(0~1)를 뽑아낸다.
// 네 가지 고급 기능(레인지 추정/보드 텍스처/익스플로잇/멀티스트리트 플랜) 모두 이 값을
// 그대로 공유해서 쓴다 - 특정 기능만 먼저 켜지는 게 아니라, 실력이 20%면 넷 다 조금씩,
// 50%면 넷 다 조금 더, 80%면 넷 다 많이, 100%면 넷 다 거의 최대로 반영되도록 하기 위함.
function advancedFeatureWeight(skill) {
  return clamp(skill / 100, 0, 1);
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

// 보드 텍스처에 따라 베팅 사이즈(팟 비율)를 조정한다. 웻(역동적)한 보드일수록 크게,
// 드라이(정적)한 보드일수록 작게 - 실제 사람들이 흔히 쓰는 원칙이다. weight(0~1)는
// aiSkillLevel에서 유도된 가중치로, 0이면 조정 없이 기존 fraction을 그대로 쓴다.
function textureSizeAdjust(fraction, texture, weight) {
  if (weight <= 0) return fraction;
  const delta = (texture.wetness - 0.5) * 0.3; // 최대 ±0.15
  return clamp(fraction + delta * weight, 0.25, 1.5);
}

// 보드 텍스처에 따라 (순수) 블러프 빈도를 조정한다. 드라이한 보드는 블러프가 더 잘 먹히므로
// 늘리고, 웻한 보드는 상대가 계속 따라올 손패가 많아 블러프 효율이 떨어지므로 줄인다.
function textureBluffAdjust(freq, texture, weight) {
  if (weight <= 0) return freq;
  const mult = 1 + (0.5 - texture.wetness) * 0.8 * weight; // 드라이(wetness↓) -> mult>1
  return Math.max(0.02, freq * mult);
}

// 상대별 누적 성향(OpponentModel)을 바탕으로 블러프/밸류/콜 임계값을 조정한다.
// weight(0~1)는 aiSkillLevel에서 유도된 가중치. 표본이 부족한 상대는 통계가 null로
// 돌아오므로 자연히 조정에서 빠진다(=평균적인 상대라고 가정).
function exploitAdjustments(opponentModel, activeOpponentSeats, weight) {
  const neutral = { bluffMult: 1, valueMult: 1, callLooseness: 0 };
  if (!opponentModel || weight <= 0 || !activeOpponentSeats.length) return neutral;

  const foldRates = [];
  const aggRates = [];
  for (const idx of activeOpponentSeats) {
    const f = opponentModel.foldToBetRate(idx);
    if (f != null) foldRates.push(f);
    const a = opponentModel.aggressionRate(idx);
    if (a != null) aggRates.push(a);
  }

  let bluffMult = 1;
  let valueMult = 1;
  if (foldRates.length) {
    const avgFold = foldRates.reduce((a, b) => a + b, 0) / foldRates.length;
    // 폴드를 잘하는(50% 초과) 상대에게는 블러프를 늘리고, 콜스테이션(폴드를 잘 안 함)에게는
    // 블러프를 줄이는 대신 밸류벳을 두껍게(사이즈를 키움) 가져간다.
    bluffMult = clamp(1 + (avgFold - 0.5) * 1.4 * weight, 0.4, 1.8);
    valueMult = clamp(1 - (avgFold - 0.5) * 0.5 * weight, 0.85, 1.3);
  }

  let callLooseness = 0;
  if (aggRates.length) {
    const avgAgg = aggRates.reduce((a, b) => a + b, 0) / aggRates.length;
    // 평소 공격적인(베팅/레이즈가 잦은) 상대에게는 블러프가 섞여있을 가능성을 감안해
    // 브러프캐치성 콜 기준을 살짝 넓힌다.
    callLooseness = clamp((avgAgg - 0.5) * 0.06 * weight, -0.05, 0.05);
  }

  return { bluffMult, valueMult, callLooseness };
}

// 스트리트 이름 -> 다음 스트리트 이름. 리버 다음은 없음(플랜을 새로 세우지 않음).
const NEXT_STREET = { flop: 'turn', turn: 'river' };

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
 *
 * skillLevel이 높을수록 아래 네 가지 "고급" 기능이 모두 함께, 같은 비율로 더 강하게
 * 반영된다(advancedFeatureWeight = skillLevel/100 - 20%면 넷 다 조금씩, 100%면 넷 다 거의
 * 최대로. 특정 기능만 먼저 켜지고 나머지는 나중에 켜지는 방식이 아니다):
 *  1) 상대 레인지 추정: 포스트플랍 이퀴티 계산 시 이번 핸드 상대의 프리플랍 액션을 참고해
 *     상대 홀카드를 무작위가 아니라 그 액션에 맞는 레인지에서 뽑는다(RangeModel).
 *  2) 보드 텍스처 조정: 팟 비율만 보던 고정 구간 대신, 드라이/웻 정도에 따라 베팅 사이즈와
 *     블러프 빈도를 조정한다(BoardTexture).
 *  3) 상대별 익스플로잇: 세션 동안 누적된 상대 성향(폴드율/공격성)에 따라 블러프/밸류/콜
 *     기준을 조정한다(OpponentModel, opts.opponentModel로 전달받음).
 *  4) 멀티스트리트 플랜: 이번 핸드의 이전 스트리트 판단(체크 후 다음 스트리트에 블러프
 *     이어가기, 강한 패를 슬로우플레이했다가 다음 스트리트에 크게 베팅/레이즈하기)을
 *     engine.hs[seatIndex].aiPlan에 저장해 다음 스트리트 판단에 반영한다.
 */
function decidePostflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const mistakeRate = opts.mistakeRate != null ? opts.mistakeRate : 0.08;
  const skill = clamp(opts.skillLevel != null ? opts.skillLevel : 75, 0, 100);
  // 아래 "근거 약한 브러프캐치 콜/세미블러프" 같은 고정확률 잡버릇에 곱하는 배율.
  // skill===75(기존 기본값)에서 1이라 기존 튜닝을 그대로 보존하고, skill=100이면 0이 되어
  // "실력 100%인데 말도 안 되는 A하이 콜이 나온다"는 문제를 없앤다.
  const quirk = quirkFactor(skill);
  const hs = engine.hs[seatIndex];

  const opponentSeats = engine.activePlayerSeats().filter((i) => i !== seatIndex);
  const numOpponents = opponentSeats.length;

  // 네 가지 고급 기능 모두 같은 가중치를 공유한다(20%면 넷 다 조금씩, 100%면 넷 다 거의 최대로).
  const advancedWeight = advancedFeatureWeight(skill);
  const rangeWeight = advancedWeight;
  const textureWeight = advancedWeight;
  const exploitWeight = advancedWeight;
  const planWeight = advancedWeight;

  // 1) 상대 레인지 추정 (skillWeight가 0이면 buildOpponentRangeFilters가 null을 돌려줘서
  //    estimateEquity가 예전처럼 완전 무작위 상대 패로 계산한다)
  const opponentFilters = buildOpponentRangeFilters(engine, opponentSeats, rangeWeight, rng);

  // skillLevel이 높을수록 몬테카를로 반복 횟수를 늘려 이퀴티 추정의 통계적 잡음을 줄인다.
  const baseIterations = Math.round(120 + (skill / 100) * 480); // 120~600
  const iterations = Math.max(70, baseIterations - numOpponents * 20);
  const rawEquity = estimateEquity(hs.holeCards, engine.board, numOpponents, rng, iterations, opponentFilters);

  let noise = 0;
  // 실력과 무관하게 드물게 섞이는 큰 실수(이퀴티 오판)
  if (rng() < mistakeRate) noise += (rng() - 0.5) * 0.3;
  // 실력이 낮을수록 매 판단마다 항상 섞이는 잔잡음(0=아주 부정확, 100=거의 없음)
  noise += (rng() - 0.5) * (1 - skill / 100) * 0.22;
  const equity = clamp(rawEquity + noise, 0, 1);

  const pot = engine.potNow();

  // 2) 보드 텍스처
  const texture = classifyBoardTexture(engine.board);

  // 3) 상대별 익스플로잇
  const exploit = exploitAdjustments(opts.opponentModel, opponentSeats, exploitWeight);

  // 4) 멀티스트리트 플랜 - 지난 스트리트에 세워둔 계획이 있고, 지금이 그 계획의 대상
  //    스트리트라면 여기서 먼저 확인한다. 실제로 쓰든 안 쓰든 이번에 소비하고 지운다
  //    (한 스트리트만 미리 내다보는 단순한 플랜이라 계속 들고 다니지 않는다).
  const plan = hs.aiPlan && hs.aiPlan.dueStreet === engine.street ? hs.aiPlan : null;
  hs.aiPlan = null;

  if (legal.callAmount === 0) {
    // 체크로 넘어온 상황(내 차례에 아무도 베팅하지 않음): 베팅 여부 결정

    // 멀티스트리트 플랜: 지난 스트리트에 "체크하고 이 스트리트에 블러프 이어가기"를
    // 계획했었다면, 이번 판단의 순간적인 이퀴티 판독과 무관하게 계획대로 베팅을 이어간다
    // (실제로 계속 밀어붙이지 않으면 애초에 계획을 세운 의미가 없다).
    if (plan && plan.type === 'delayedBluff' && legal.canRaise && rng() < 0.8) {
      return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.55 + rng() * 0.2, texture, textureWeight)) };
    }

    if (equity > 0.68) {
      const raiseChance = clamp(0.88 * exploit.valueMult, 0.5, 0.97);
      if (legal.canRaise && rng() < raiseChance) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.62 + rng() * 0.18, texture, textureWeight) * exploit.valueMult) };
      }
      // 슬로우플레이 플랜: 아주 강한 패인데도 이번엔 베팅하지 않고 체크로 넘어가기로 했다면,
      // 다음 스트리트에는 계획대로 크게 베팅/레이즈해서 상대를 더 물게 만든다.
      if (planWeight > 0 && NEXT_STREET[engine.street] && rng() < 0.35 * planWeight) {
        hs.aiPlan = { type: 'slowplay', dueStreet: NEXT_STREET[engine.street] };
      }
    } else if (equity > 0.45) {
      if (legal.canRaise && rng() < 0.4) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.45 + rng() * 0.15, texture, textureWeight)) };
      }
    } else {
      // 순수 블러프(체크로 넘어왔는데 에퀴티가 낮은데도 베팅) 빈도. 예전에는 0.28을 기준으로
      // 써서 헤즈업 기준 최대 14%, 상대가 적을수록 더 자주 블러프를 걸었는데, 사용자 피드백
      // ("블러프가 너무 많은 것 같다")을 반영해 기준치를 낮췄다(0.28 -> 0.20).
      const baseBluffFreq = Math.max(0.04, 0.2 / (numOpponents + 1));
      const bluffFreq = textureBluffAdjust(baseBluffFreq, texture, textureWeight) * exploit.bluffMult;
      if (legal.canRaise && rng() < bluffFreq) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.55 + rng() * 0.2, texture, textureWeight)) };
      }
      // 지금 당장은 블러프를 안 걸기로 했더라도, 다음 스트리트에 이어서 블러프를 걸어보는
      // "지연 블러프"(체크 후 턴에 블러프 이어가기) 계획을 대신 세울 수 있다.
      if (planWeight > 0 && NEXT_STREET[engine.street] && rng() < bluffFreq * 1.5 * planWeight) {
        hs.aiPlan = { type: 'delayedBluff', dueStreet: NEXT_STREET[engine.street] };
      }
    }
    return { actionType: 'check' };
  }

  // 상대 베팅에 대응
  const requiredEquity = legal.callAmount / (pot + legal.callAmount) - exploit.callLooseness;

  // 슬로우플레이 플랜이 실현되는 순간: 지난 스트리트에 트랩을 깔아뒀는데 상대가 먼저
  // 베팅해왔다면, 그냥 콜만 하지 않고 훨씬 자주 (체크)레이즈로 되받아친다.
  if (plan && plan.type === 'slowplay' && equity > requiredEquity && legal.canRaise && rng() < 0.75) {
    return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.75 + rng() * 0.2, texture, textureWeight)) };
  }

  if (equity > requiredEquity + 0.22) {
    // 콜에 필요한 에퀴티보다 여유 있게 앞서는 구간에서의 레이즈(밸류/세미블러프성) 빈도.
    // 55%는 지나치게 자주 되받아치는 느낌을 줄 수 있어 낮췄다(0.55 -> 0.4).
    if (legal.canRaise && rng() < 0.4) {
      return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.65 + rng() * 0.2, texture, textureWeight) * exploit.valueMult) };
    }
    return legal.canCall ? { actionType: 'call' } : { actionType: 'check' };
  }
  if (equity > requiredEquity) {
    return legal.canCall ? { actionType: 'call' } : { actionType: 'check' };
  }

  const gap = requiredEquity - equity;
  if (gap < 0.08 && legal.canCall && rng() < 0.3 * quirk) {
    return { actionType: 'call' }; // 브러프캐치 믹스(실력 100%면 0 - "말도 안 되는 콜" 방지)
  }
  if (equity > 0.3 && equity < 0.5 && legal.canRaise && rng() < 0.08 * quirk) {
    return { actionType: 'raise', amount: sizeBet(engine, legal, 0.6) }; // 세미블러프(실력 100%면 0)
  }
  return { actionType: legal.canCheck ? 'check' : 'fold' };
}

module.exports = {
  decidePostflop,
  sizeBet,
  // 아래는 단위 테스트 및 (필요하다면) 다른 모듈에서의 재사용을 위해 함께 내보낸다.
  advancedFeatureWeight,
  textureSizeAdjust,
  textureBluffAdjust,
  exploitAdjustments,
};
