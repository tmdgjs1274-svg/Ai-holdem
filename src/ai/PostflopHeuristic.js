'use strict';

const { estimateEquity } = require('./Equity');
const { roundRaiseTo, quirkFactor, bigBlunderChance, gtoBluffRatio, minDefenseFrequency } = require('./util');
const { classifyBoardTexture } = require('./BoardTexture');
const { buildOpponentRangeFilters } = require('./RangeModel');
const { evaluateBest } = require('../game/HandEvaluator');
const { handNamePlain, boardPlain, fmtChips } = require('./Explain');

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

// 정확히 "세컨페어(또는 그 이하)" 원페어 - 보드 최고카드보다 낮은 랭크로 페어를 맞춘
// 경우 - 만 감쇠 대상으로 삼는다. 탑페어나 오버페어(포켓페어가 보드보다 높은 경우)는 여기
// 해당하지 않아 그대로 강하게 밸류벳한다 - 실제로도 탑페어/오버페어는 계속 베팅하는 게
// 정상이고, 사용자가 지적한 건 "세컨페어"에 한정된 문제이기 때문이다. heroPairRank가
// null이면(원페어가 아니면) 애초에 대상이 아니다.
function isBelowTopPair(heroCategory, heroPairRank, texture) {
  return heroCategory === 2 && heroPairRank != null && heroPairRank < texture.highRank;
}

// 세컨페어(이하) 원페어는 웻(역동적)한 보드일수록 계속 레이즈/벳으로 밀어붙이기보다,
// 쇼다운밸류를 지키며 체크/콜로 상대의 블러프를 유도하거나 브러프캐치를 하는 편이 일반적인
// 사람의 플레이에 가깝다(사용자 피드백: "세컨페어에 쇼다운밸류가 없다고 생각하는 것처럼
// 리레이즈/벳을 막 갈긴다"). 몬테카를로 이퀴티만 보면 세컨페어도 무작위 상대 레인지 대비
// 종종 0.68을 넘어 "강한 밸류벳" 구간으로 분류되어 버리는데(실제로는 상대의 베팅/레이즈
// 레인지에는 그보다 강한 손패가 많이 섞여 있다), 그 구간에서도 이 감쇠를 함께 적용한다.
// 드라이한 보드에서는 크게 줄이지 않는다(드로우가 적어 얇은 밸류벳/프로텍션 벳이 여전히
// 합리적이기 때문).
function onePairAggressionDamp(heroCategory, heroPairRank, texture) {
  if (!isBelowTopPair(heroCategory, heroPairRank, texture)) return 1;
  return clamp(0.85 - texture.wetness * 0.5, 0.35, 0.85);
}

// 노페어(하이카드)류 손패는 몬테카를로로 뽑은 원시 이퀴티만으로는, 웻한 보드에서 상대의
// 벳/레이즈 레인지가 (드로우나 메이드핸드로) 강하게 쏠려 있고 남은 스트리트에서 실제로
// 실현되는 이퀴티가 원시 추정치보다 낮다는 "리버스 임플라이드 오즈"를 반영하지 못한다.
// 웻할수록 소폭 할인해, 근거 약한 에이스하이류 콜다운이 과도해지지 않도록 한다.
function noPairWetBoardDiscount(heroCategory, texture) {
  if (heroCategory !== 1) return 0;
  return texture.wetness * 0.1;
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
 * 난이도는 skillLevel(0~100) 하나로 조절한다. 기본 판단 정밀도를 결정하는 동시에, 매 판단마다
 * 항상 적용되는 "실력 잡음"의 크기, 이퀴티 추정에 쓰는 몬테카를로 반복 횟수(=추정 노이즈),
 * 그리고 드물게 "확 틀리는" 큰 실수(틸트/순간 방심, util.bigBlunderChance)까지 함께 결정한다.
 * 낮을수록 항상 어느 정도 부정확하게 판단하고(초보자처럼 손패 가치를 오판) 가끔 큰 실수도
 * 하며, 100이면 반복 횟수가 최대치라 이퀴티 추정 자체의 통계적 잡음도 최소화되고 큰 실수도
 * 전혀 없다. (예전에는 이 "드문 큰 실수"를 skillLevel과 무관한 별도의 mistakeRate 축으로
 * 따로 뒀지만, "실력 100%로 올려도 mistakeRate 축이 남아있어 여전히 이상한 플레이가 나온다"는
 * 혼란이 있어 이제는 skillLevel 하나로 합쳤다.)
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
 *
 * 이 네 가지와 별개로, skillLevel과 무관하게 항상 적용되는 두 가지 보정이 있다(현재 보드
 * 기준 실제 메이드핸드 카테고리, heroCategory를 사용):
 *  - onePairAggressionDamp: 원페어("세컨페어류") 손패는 웻한 보드일수록 레이즈/벳 빈도를
 *    줄여, 쇼다운밸류를 지키며 체크/콜(브러프캐치)하는 쪽을 선호하게 한다.
 *  - noPairWetBoardDiscount: 노페어(하이카드) 손패는 웻한 보드에서 이퀴티를 소폭 할인해,
 *    근거 약한 에이스하이류 콜다운이 과도해지지 않게 한다.
 *
 * "실력 100%면 거의 솔버처럼" 요청에 따라, 두 지점에서는 advancedFeatureWeight(=skillLevel/100)
 * 만큼 상대수/텍스처 기반의 손튜닝된 고정 확률 대신 베팅 사이즈에서 직접 역산한 GTO 공식으로
 * 옮겨간다(skillLevel=100이면 공식값을 그대로 씀, 0이면 예전 고정 확률을 그대로 씀):
 *  - 체크로 넘어왔을 때의 순수 블러프 빈도: gtoBluffRatio(베팅사이즈/팟) - "이 사이즈로 벨류:
 *    블러프를 이 비율로 섞어야 상대가 항상 콜/항상 폴드 어느 쪽으로도 착취할 수 없다"는
 *    폴라라이즈드 벳의 핵심 공식. 사이즈가 클수록 블러프 비율도 커진다.
 *  - 상대 베팅에 대응할 때의 브러프캐치 콜 빈도: minDefenseFrequency(상대베팅/팟) - 상대가
 *    작게 베팅했으면 넓게 방어하고, 오버벳이면 좁게 방어(더 자주 폴드)하는 최소방어빈도(MDF)
 *    공식. "실력 100%면 브러프캐치를 절대 안 한다"가 아니라 "사이즈에 맞는 만큼만 원칙적으로
 *    브러프캐치한다"로 바뀐 것이 핵심 차이다.
 */
function decidePostflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
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
  // 드물게 섞이는 큰 실수(이퀴티 오판) - 실력 100%면 0
  if (rng() < bigBlunderChance(skill)) noise += (rng() - 0.5) * 0.3;
  // 실력이 낮을수록 매 판단마다 항상 섞이는 잔잡음(0=아주 부정확, 100=거의 없음)
  noise += (rng() - 0.5) * (1 - skill / 100) * 0.22;
  let equity = clamp(rawEquity + noise, 0, 1);

  const pot = engine.potNow();

  // 2) 보드 텍스처
  const texture = classifyBoardTexture(engine.board);

  // 현재 보드 기준 실제 메이드핸드 카테고리(1=하이카드, 2=원페어, ...)와, 원페어일 때 그
  // 페어의 랭크(탑페어/세컨페어 구분에 사용). 세컨페어류 손패의 과도한 공격성 감쇠, 노페어
  // 손패의 웻보드 할인에 사용한다.
  const heroBest = evaluateBest([...hs.holeCards, ...engine.board]);
  const heroCategory = heroBest.category;
  const heroPairRank = heroCategory === 2 ? heroBest.tiebreakers[0] : null;
  equity = clamp(equity - noPairWetBoardDiscount(heroCategory, texture), 0, 1);
  const onePairDamp = onePairAggressionDamp(heroCategory, heroPairRank, texture);

  // 3) 상대별 익스플로잇
  const exploit = exploitAdjustments(opts.opponentModel, opponentSeats, exploitWeight);

  // 4) 멀티스트리트 플랜 - 지난 스트리트에 세워둔 계획이 있고, 지금이 그 계획의 대상
  //    스트리트라면 여기서 먼저 확인한다. 실제로 쓰든 안 쓰든 이번에 소비하고 지운다
  //    (한 스트리트만 미리 내다보는 단순한 플랜이라 계속 들고 다니지 않는다).
  const plan = hs.aiPlan && hs.aiPlan.dueStreet === engine.street ? hs.aiPlan : null;
  hs.aiPlan = null;

  // ---- AI 액션 리뷰용 설명 조각 (판단에는 영향 없음) ----
  const pct = (v) => `${Math.round(v * 100)}%`;
  const wetLabel = texture.wetness >= 0.6 ? '웻' : texture.wetness >= 0.3 ? '중간' : '드라이';
  const textureTxt = `보드 ${wetLabel}(${texture.wetness.toFixed(2)})`;
  const handTxt = heroBest.name || '핸드';
  const dampTxt = onePairDamp < 1 ? ` · 세컨페어 이하 원페어라 공격성 ×${onePairDamp.toFixed(2)} 감쇠` : '';
  const discTxt = noPairWetBoardDiscount(heroCategory, texture) > 0 ? ` · 노페어 웻보드 이퀴티 할인 −${pct(noPairWetBoardDiscount(heroCategory, texture))}p` : '';
  const baseTxt = `${handTxt}, 이퀴티 ${pct(equity)}(상대 ${numOpponents}명), ${textureTxt}${dampTxt}${discTxt}`;
  // 쉬운 말 설명: situation(한 줄 상황 요약), reason(이유 문장). detail은 기술적인 숫자 설명(화면에서는
  // "숫자 자세히 보기"를 켰을 때만 보임). mods=true면 이번 판단에 실제로 영향을 준 보정을 쉬운 말로 덧붙인다.
  const situation = `${handNamePlain(handTxt)} · 이길 확률 약 ${pct(equity)}${numOpponents > 1 ? ` · 상대 ${numOpponents}명` : ' · 상대 1명'} · ${boardPlain(texture.wetness)}`;
  const modsPlain = [];
  if (onePairDamp < 1) modsPlain.push('원페어는 더 센 패에게 질 위험이 있어서 평소보다 조심스럽게 플레이했어요.');
  if (noPairWetBoardDiscount(heroCategory, texture) > 0) modsPlain.push('아직 족보가 없는데 보드가 위험해서, 이길 확률을 조금 보수적으로 잡았어요.');
  const mk = (plain, extra, mods = true) => ({
    reason: mods && modsPlain.length ? `${plain} ${modsPlain.join(' ')}` : plain,
    situation,
    detail: `${baseTxt} → ${extra}`,
    meta: { equity, street: engine.street, texture: wetLabel },
  });

  if (legal.callAmount === 0) {
    // 체크로 넘어온 상황(내 차례에 아무도 베팅하지 않음): 베팅 여부 결정

    // 멀티스트리트 플랜: 지난 스트리트에 "체크하고 이 스트리트에 블러프 이어가기"를
    // 계획했었다면, 이번 판단의 순간적인 이퀴티 판독과 무관하게 계획대로 베팅을 이어간다
    // (실제로 계속 밀어붙이지 않으면 애초에 계획을 세운 의미가 없다).
    if (plan && plan.type === 'delayedBluff' && legal.canRaise && rng() < 0.8) {
      return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.55 + rng() * 0.2, texture, textureWeight)), ...mk('지난 라운드에 체크하면서 "다음 라운드에 센 척(허세)으로 베팅하자"고 미리 계획해 둔 대로, 이번에 베팅했어요.', '지난 스트리트에 세운 "지연 블러프" 계획대로 베팅 이어감', false) };
    }

    let checkNote = '베팅할 만큼의 이점이 없어 체크';
    let checkPlain = '베팅할 만큼 유리하지 않아서 체크했어요.';
    let slowplayed = false;
    if (equity > 0.68) {
      // 세컨페어(이하)인데도 무작위 레인지 기준 이퀴티가 0.68을 넘어 이 "강한 밸류벳" 구간에
      // 들어온 경우에도 onePairDamp를 함께 적용한다(그 외 손패는 damp=1이라 영향 없음).
      const raiseChance = clamp(0.88 * exploit.valueMult * onePairDamp, 0.25, 0.97);
      if (legal.canRaise && rng() < raiseChance) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.62 + rng() * 0.18, texture, textureWeight) * exploit.valueMult), ...mk('상대보다 확실히 앞서 있다고 보고, 상대가 더 많은 돈을 내도록 베팅했어요.', `강한 밸류벳(이퀴티 > 68%, 베팅 확률 ${pct(raiseChance)})`) };
      }
      // 슬로우플레이 플랜: 아주 강한 패인데도 이번엔 베팅하지 않고 체크로 넘어가기로 했다면,
      // 다음 스트리트에는 계획대로 크게 베팅/레이즈해서 상대를 더 물게 만든다.
      if (planWeight > 0 && NEXT_STREET[engine.street] && rng() < 0.35 * planWeight) {
        hs.aiPlan = { type: 'slowplay', dueStreet: NEXT_STREET[engine.street] };
        slowplayed = true;
      }
      checkNote = slowplayed
        ? `강한 패지만 슬로우플레이(체크) - 다음 스트리트에 크게 베팅/레이즈 예정`
        : `강한 패지만 이번엔 베팅 대신 체크(베팅 확률 ${pct(raiseChance)}, 믹스 전략)`;
      checkPlain = slowplayed
        ? '아주 강한 패라서 일부러 체크했어요. 상대가 방심하게 만들었다가 다음 라운드에 크게 받으려는 함정이에요.'
        : '강한 패지만, 매번 똑같이 베팅하면 상대가 내 패를 읽어버려서 이번에는 일부러 체크했어요.';
    } else if (equity > 0.45) {
      if (legal.canRaise && rng() < 0.4 * onePairDamp) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.45 + rng() * 0.15, texture, textureWeight)), ...mk('상대보다 조금 앞서 있다고 보고, 약한 패를 내보내고 공짜 카드를 주지 않으려고 적당한 크기로 베팅했어요.', `중간 강도 얇은 밸류/프로텍션 벳(이퀴티 45~68%, 베팅 확률 ${pct(0.4 * onePairDamp)})`) };
      }
      checkNote = `중간 강도 - 팟 컨트롤/쇼다운 밸류 유지를 위해 체크(베팅 확률 ${pct(0.4 * onePairDamp)}${onePairDamp < 1 ? ', 세컨페어 감쇠 반영' : ''})`;
      checkPlain = '조금 앞서 있긴 하지만 확실하진 않아서, 판돈을 키우지 않고 체크했어요. 끝까지 가서 패를 비교해도 이길 수 있는 정도예요.';
    } else {
      // 순수 블러프(체크로 넘어왔는데 에퀴티가 낮은데도 베팅) 빈도. 예전에는 0.28을 기준으로
      // 써서 헤즈업 기준 최대 14%, 상대가 적을수록 더 자주 블러프를 걸었는데, 사용자 피드백
      // ("블러프가 너무 많은 것 같다")을 반영해 기준치를 낮췄다(0.28 -> 0.20).
      const baseBluffFreq = Math.max(0.04, 0.2 / (numOpponents + 1));
      // 실력이 높을수록(advancedWeight), 상대수 기반의 고정 휴리스틱 대신 "이번에 쓸 베팅
      // 사이즈"에서 역산한 GTO 폴라라이즈드 블러프 비율(gtoBluffRatio)로 옮겨간다 - "100%면
      // 거의 솔버처럼" 요청에 따른 것으로, 실제 폴라라이즈드 벳은 사이즈가 클수록 블러프도
      // 그만큼 더 많이 섞어야 상대가 항상 콜/항상 폴드 중 하나로 착취할 수 없다.
      const bluffSizeFrac = textureSizeAdjust(0.65, texture, textureWeight);
      const gtoFreq = gtoBluffRatio(bluffSizeFrac) / Math.max(1, numOpponents);
      const blendedBaseFreq = baseBluffFreq + (gtoFreq - baseBluffFreq) * advancedWeight;
      const bluffFreq = textureBluffAdjust(blendedBaseFreq, texture, textureWeight) * exploit.bluffMult;
      if (legal.canRaise && rng() < bluffFreq) {
        return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.55 + rng() * 0.2, texture, textureWeight)), ...mk(`내 패는 약하지만, 상대가 겁먹고 접도록 일부러 센 척(허세) 베팅했어요. 가끔 이렇게 섞어야 상대가 내 베팅만 보고 패를 맞히기 어려워요.${texture.wetness < 0.3 ? ' 보드가 안정적이라 허세가 잘 통하는 편이에요.' : ''}${exploit.bluffMult > 1.15 ? ' 상대가 자주 접는 스타일이라 허세를 평소보다 더 썼어요.' : exploit.bluffMult < 0.85 ? ' 상대가 잘 안 접는 스타일이지만 균형을 위해 섞었어요.' : ''}`, `블러프 벳(이퀴티 낮음, 블러프 빈도 ${pct(bluffFreq)}: ${advancedWeight > 0.5 ? 'GTO 폴라라이즈 비율 반영' : '기본 휴리스틱'}${exploit.bluffMult !== 1 ? `, 상대 성향 보정 ×${exploit.bluffMult.toFixed(2)}` : ''})`, false) };
      }
      checkNote = `이퀴티가 낮아 체크(블러프 빈도 ${pct(bluffFreq)} 미당첨)`;
      checkPlain = '이길 확률이 낮아서 허세도 부리지 않고 그냥 체크했어요. 돈을 더 쓰지 않고 다음 카드를 보려는 거예요.';
      // 지금 당장은 블러프를 안 걸기로 했더라도, 다음 스트리트에 이어서 블러프를 걸어보는
      // "지연 블러프"(체크 후 턴에 블러프 이어가기) 계획을 대신 세울 수 있다.
      if (planWeight > 0 && NEXT_STREET[engine.street] && rng() < bluffFreq * 1.5 * planWeight) {
        hs.aiPlan = { type: 'delayedBluff', dueStreet: NEXT_STREET[engine.street] };
        checkNote += ' · 다음 스트리트 블러프 이어가기 계획 수립';
        checkPlain += ' 다음 라운드에 허세를 이어갈 계획도 세워 뒀어요.';
      }
    }
    return { actionType: 'check', ...mk(checkPlain, checkNote, equity > 0.45) };
  }

  // 상대 베팅에 대응
  const requiredEquity = legal.callAmount / (pot + legal.callAmount) - exploit.callLooseness;

  // 슬로우플레이 플랜이 실현되는 순간: 지난 스트리트에 트랩을 깔아뒀는데 상대가 먼저
  // 베팅해왔다면, 그냥 콜만 하지 않고 훨씬 자주 (체크)레이즈로 되받아친다.
  if (plan && plan.type === 'slowplay' && equity > requiredEquity && legal.canRaise && rng() < 0.75) {
    return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.75 + rng() * 0.2, texture, textureWeight)), ...mk('미리 깔아둔 함정대로, 상대가 베팅하자 크게 다시 올렸어요.', `슬로우플레이 계획 실현: 이퀴티 ${pct(equity)} > 필요 ${pct(requiredEquity)} → 체크레이즈`, false) };
  }

  const potOddsTxt = `콜 ${legal.callAmount} / 팟 ${pot + legal.callAmount} → 필요 이퀴티 ${pct(requiredEquity)}`;
  const oddsPlain = `${fmtChips(legal.callAmount)}을 더 내면 판돈 ${fmtChips(pot + legal.callAmount)}을 가져갈 수 있어서, 이길 확률이 약 ${pct(requiredEquity)}만 넘으면 따라가는 게 이득이에요.`;

  if (equity > requiredEquity + 0.22) {
    // 콜에 필요한 에퀴티보다 여유 있게 앞서는 구간에서의 레이즈(밸류/세미블러프성) 빈도.
    // 55%는 지나치게 자주 되받아치는 느낌을 줄 수 있어 낮췄다(0.55 -> 0.4). 원페어 정도의
    // 손패는 onePairDamp로 한 번 더 줄여, 웻한 보드일수록 레이즈보다 콜(쇼다운밸류 유지/
    // 브러프캐치)을 선호하게 한다.
    if (legal.canRaise && rng() < 0.4 * onePairDamp) {
      return { actionType: 'raise', amount: sizeBet(engine, legal, textureSizeAdjust(0.65 + rng() * 0.2, texture, textureWeight) * exploit.valueMult), ...mk('상대의 베팅에 비해 내 패가 훨씬 낫다고 보고, 한 번 더 올려서 이득을 키우려 했어요.', `필요 이퀴티(${pct(requiredEquity)})보다 22%p 넘게 앞서 레이즈(${potOddsTxt}, 레이즈 확률 ${pct(0.4 * onePairDamp)})`) };
    }
    return legal.canCall
      ? { actionType: 'call', ...mk('내 패가 충분히 좋아서 따라가기로 했어요. 굳이 더 올리지 않고 콜만 해서 상대가 계속 돈을 넣도록 두는 선택이에요.', `필요 이퀴티보다 크게 앞서지만 레이즈 대신 콜(${potOddsTxt}, 레이즈 확률 ${pct(0.4 * onePairDamp)}${onePairDamp < 1 ? ' - 세컨페어 감쇠로 콜 선호' : ''})`) }
      : { actionType: 'check', ...mk('따라가야 할 돈이 없어서 체크했어요.', '콜할 금액 없음 → 체크', false) };
  }
  if (equity > requiredEquity) {
    return legal.canCall
      ? { actionType: 'call', ...mk(`따라가는 게 이득이라고 판단해서 콜했어요. ${oddsPlain}`, `팟오즈상 콜 이득(${potOddsTxt})`) }
      : { actionType: 'check', ...mk('따라가야 할 돈이 없어서 체크했어요.', '콜할 금액 없음 → 체크', false) };
  }

  const gap = requiredEquity - equity;
  if (gap < 0.08 && legal.canCall) {
    // 최소방어빈도(MDF) 기반 브러프캐치 콜. 예전에는 skillLevel과 무관한 고정 30%(quirk로만
    // 스케일)였는데, "100%면 거의 솔버처럼" 요청에 따라 실력이 높을수록 상대 베팅 사이즈에서
    // 역산한 MDF로 옮겨간다 - 상대가 작게 베팅했으면 훨씬 넓게 방어하고, 오버벳이면 좁게
    // 방어하는(더 자주 폴드하는) 솔버의 핵심 성질을 반영한다. MDF 전체가 이 브러프캐치
    // 구간에서만 채워지는 게 아니라(위 "항상 콜" 구간이 이미 상당 부분을 채움) 보수적으로
    // 0.6배만 반영한다.
    const betSizeFrac = legal.callAmount / Math.max(1, pot - legal.callAmount);
    const gtoBluffcatchProb = clamp(minDefenseFrequency(betSizeFrac) * 0.6, 0.1, 0.85);
    const oldBluffcatchProb = 0.3 * quirk; // 실력 낮을수록 예전처럼 고정 확률(quirk 배율) 유지
    const bluffcatchProb = oldBluffcatchProb + (gtoBluffcatchProb - oldBluffcatchProb) * advancedWeight;
    if (rng() < bluffcatchProb) {
      return { actionType: 'call', ...mk(`이길 확률이 약 ${pct(equity)}로 필요한 ${pct(requiredEquity)}에 조금 모자라지만 거의 근접해서, 상대가 허세일 가능성에 걸고 따라갔어요. 너무 쉽게 접으면 상대가 허세만으로 계속 이길 수 있어서 가끔 버텨 줘요.`, `브러프캐치 콜: 이퀴티가 필요치에 ${pct(gap)}p 모자라지만 근접(${potOddsTxt}), 최소방어빈도(MDF) 블렌드 콜 확률 ${pct(bluffcatchProb)}`, false) };
    }
  }
  if (equity > 0.3 && equity < 0.5 && legal.canRaise && rng() < 0.08 * quirk) {
    return { actionType: 'raise', amount: sizeBet(engine, legal, 0.6), ...mk('이길 확률은 낮지만, 가끔은 일부러 레이즈로 센 척해서 상대가 접도록 만들어요(허세 섞기).', '세미블러프 레이즈(낮은 확률 믹스, 실력 높을수록 줄어듦)', false) }; // 세미블러프(실력 100%면 0)
  }
  return legal.canCheck
    ? { actionType: 'check', ...mk('따라가야 할 돈이 없어서 공짜로 넘어갔어요(체크).', '무료로 체크', false) }
    : { actionType: 'fold', ...mk(`이길 확률이 약 ${pct(equity)}인데 따라가려면 ${pct(requiredEquity)} 이상은 돼야 본전이에요. 돈을 더 넣어봐야 손해라고 보고 포기했어요.${gap < 0.08 ? ' 아슬아슬했지만 이번에는 버티지 않았어요.' : ''}`, `폴드: 이퀴티 ${pct(equity)} < 필요 ${pct(requiredEquity)}(${potOddsTxt}), 부족분 ${pct(gap)}p${gap < 0.08 ? ' - 브러프캐치 확률 미당첨' : ''}`, false) };
}

module.exports = {
  decidePostflop,
  sizeBet,
  // 아래는 단위 테스트 및 (필요하다면) 다른 모듈에서의 재사용을 위해 함께 내보낸다.
  advancedFeatureWeight,
  textureSizeAdjust,
  textureBluffAdjust,
  exploitAdjustments,
  onePairAggressionDamp,
  noPairWetBoardDiscount,
};
