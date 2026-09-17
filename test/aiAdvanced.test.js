'use strict';

const assert = require('assert');
const {
  decidePostflop,
  advancedFeatureWeight,
  textureSizeAdjust,
  textureBluffAdjust,
  exploitAdjustments,
  onePairAggressionDamp,
  noPairWetBoardDiscount,
} = require('../src/ai/PostflopHeuristic');
const { classifyBoardTexture } = require('../src/ai/BoardTexture');
const { cardFromString } = require('../src/game/Deck');
const { quirkFactor, bigBlunderChance, mixFrequency, gtoBluffRatio, minDefenseFrequency } = require('../src/ai/util');

function seedRng(seed) {
  // gameEngine.test.js와 동일한 결정적 PRNG (mulberry32)
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const constRng = (v) => () => v;

function cards(strs) {
  return strs.map(cardFromString);
}

// decidePostflop이 요구하는 최소한의 engine 껍데기(실제 GameEngine이 아니어도 되는,
// 이 함수가 실제로 읽는 속성/메서드만 갖춘 가짜 객체). preflopSizing.test.js와 같은 패턴.
function fakeEngine({
  street = 'flop',
  board,
  heroCards,
  currentBet = 0,
  potNow = 300,
  bigBlind = 50,
  opponentSeats = [1],
  actionLog = [],
  aiPlan = null,
}) {
  const hs = { 0: { holeCards: heroCards, aiPlan } };
  for (const idx of opponentSeats) hs[idx] = { holeCards: [] };
  return {
    street,
    board,
    currentBet,
    bigBlind,
    hs,
    actionLog,
    potNow: () => potNow,
    activePlayerSeats: () => [0, ...opponentSeats],
    handSeatsInOrder: () => [0, ...opponentSeats],
  };
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('advancedFeatureWeight: skillLevel에 정비례(20%->0.2, 50%->0.5, 80%->0.8, 100%->1.0)하고 네 기능이 모두 이 값을 공유함', () => {
    assert.ok(Math.abs(advancedFeatureWeight(20) - 0.2) < 1e-9);
    assert.ok(Math.abs(advancedFeatureWeight(50) - 0.5) < 1e-9);
    assert.ok(Math.abs(advancedFeatureWeight(80) - 0.8) < 1e-9);
    assert.strictEqual(advancedFeatureWeight(100), 1);
    assert.strictEqual(advancedFeatureWeight(0), 0);
  });

  check('quirkFactor: skillLevel=100이면 0(림프/브러프캐치성 잡버릇이 완전히 사라짐), 기존 기본값(75)에서는 1(기존 튜닝 보존)', () => {
    assert.strictEqual(quirkFactor(100), 0);
    assert.strictEqual(quirkFactor(75), 1);
    assert.strictEqual(quirkFactor(50), 2);
    assert.strictEqual(quirkFactor(0), 3);
    // 범위를 벗어난 입력이 들어와도 0~3 사이로 안전하게 clamp됨
    assert.strictEqual(quirkFactor(150), 0);
    assert.strictEqual(quirkFactor(-10), 3);
  });

  check('bigBlunderChance: 예전의 별도 aiMistakeRate 축이 skillLevel 하나로 통합됨 - skillLevel=100이면 정확히 0', () => {
    assert.strictEqual(bigBlunderChance(100), 0);
    assert.ok(bigBlunderChance(0) > bigBlunderChance(50));
    assert.ok(bigBlunderChance(50) > bigBlunderChance(100));
    assert.strictEqual(bigBlunderChance(150), 0, '범위를 벗어난 입력도 안전하게 clamp됨');
  });

  check('mixFrequency: 3벳/4벳 블러프 같은 밸런스 전략 확률은 skillLevel=100에서도 0이 되지 않고 절반만 남는다', () => {
    assert.strictEqual(mixFrequency(75), 1, '기존 기본값(75)에서는 1로 기존 튜닝 보존');
    assert.strictEqual(mixFrequency(100), 0.5, 'skill=100에서도 완전히 0이 되지 않고 0.5는 남음');
    assert.ok(mixFrequency(0) > mixFrequency(75), '실력이 낮을수록 배율이 커짐(quirkFactor와 같은 방향)');
    assert.strictEqual(mixFrequency(150), 0.5, '범위를 벗어난 입력도 안전하게 clamp됨(하한 0.5는 유지)');
    assert.strictEqual(mixFrequency(-50), 2.5, '범위를 벗어난 입력도 안전하게 clamp됨(skill<0은 0으로 취급)');
  });

  check('gtoBluffRatio: 베팅 사이즈가 클수록(팟 대비 비율↑) 블러프 비율도 커진다(폴라라이즈드 벳)', () => {
    assert.ok(Math.abs(gtoBluffRatio(0) - 0) < 1e-9, '사이즈 0이면 블러프 비율도 0');
    assert.ok(Math.abs(gtoBluffRatio(1) - 1 / 3) < 1e-9, '팟사이즈 벳(1배)이면 블러프 비율 1/3');
    assert.ok(Math.abs(gtoBluffRatio(0.5) - 0.25) < 1e-9, '하프팟 벳이면 블러프 비율 1/4');
    assert.ok(gtoBluffRatio(2) > gtoBluffRatio(1), '오버벳일수록 블러프 비율이 더 커짐');
    assert.strictEqual(gtoBluffRatio(-5), 0, '음수 입력은 0으로 취급');
  });

  check('minDefenseFrequency: 베팅 사이즈가 클수록(오버벳일수록) 최소방어빈도(MDF)는 낮아진다', () => {
    assert.strictEqual(minDefenseFrequency(0), 1, '사이즈 0이면 MDF는 1(전부 방어)');
    assert.ok(Math.abs(minDefenseFrequency(1) - 0.5) < 1e-9, '팟사이즈 벳(1배)이면 MDF 50%');
    assert.ok(minDefenseFrequency(2) < minDefenseFrequency(1), '오버벳일수록 MDF가 더 낮아짐(덜 방어해도 됨)');
    assert.strictEqual(minDefenseFrequency(-3), 1, '음수 입력은 0으로 취급되어 MDF=1');
  });

  check('onePairAggressionDamp: 정확히 "세컨페어(보드 최고카드보다 낮은 원페어)"만 감쇠하고, 웻한 보드일수록 더 줄인다', () => {
    const dryTexture = classifyBoardTexture(cards(['2c', '7d', 'Kh'])); // highRank=13(K)
    const wetTexture = classifyBoardTexture(cards(['7s', '8s', '9s'])); // highRank=9
    assert.strictEqual(onePairAggressionDamp(1, null, wetTexture), 1, '하이카드(노페어)는 이 감쇠의 대상이 아님');
    assert.strictEqual(onePairAggressionDamp(3, null, wetTexture), 1, '투페어 이상은 이 감쇠의 대상이 아님(이미 밸류벳 구간)');
    // 보드 최고카드(9)와 정확히 같은 랭크로 페어 -> 탑페어이므로 감쇠하지 않음
    assert.strictEqual(onePairAggressionDamp(2, 9, wetTexture), 1, '탑페어는 세컨페어가 아니므로 감쇠하지 않음');
    // 보드 최고카드(9)보다 낮은 랭크로 페어 -> 진짜 세컨페어이므로 감쇠함
    assert.ok(onePairAggressionDamp(2, 8, wetTexture) < 1, '세컨페어는 감쇠됨');
    assert.ok(onePairAggressionDamp(2, 8, wetTexture) < onePairAggressionDamp(2, 8, dryTexture), '세컨페어는 웻한 보드일수록 더 많이 감쇠됨');
    assert.ok(onePairAggressionDamp(2, 8, wetTexture) >= 0.35 && onePairAggressionDamp(2, 8, dryTexture) <= 0.85, '0.35~0.85 범위 안에서 감쇠');
  });

  check('noPairWetBoardDiscount: 노페어(하이카드)만 할인하고, 웻한 보드일수록 할인폭이 크다', () => {
    const dryTexture = classifyBoardTexture(cards(['2c', '7d', 'Kh']));
    const wetTexture = classifyBoardTexture(cards(['7s', '8s', '9s']));
    assert.strictEqual(noPairWetBoardDiscount(2, wetTexture), 0, '원페어 이상은 이 할인의 대상이 아님');
    assert.ok(noPairWetBoardDiscount(1, wetTexture) > noPairWetBoardDiscount(1, dryTexture), '노페어는 웻한 보드일수록 할인폭이 큼(에이스하이 콜다운 억제)');
  });

  check('textureSizeAdjust: weight=0이면 조정 없이 원래 fraction 그대로', () => {
    const wetTexture = classifyBoardTexture(cards(['7s', '8s', '9s']));
    assert.strictEqual(textureSizeAdjust(0.6, wetTexture, 0), 0.6);
  });

  check('textureSizeAdjust: 웻한 보드는 사이즈를 키우고, 드라이한 보드는 줄임', () => {
    const wet = classifyBoardTexture(cards(['7s', '8s', '9s']));
    const dry = classifyBoardTexture(cards(['2s', '9h', 'Kc']));
    const base = 0.6;
    const wetSize = textureSizeAdjust(base, wet, 1);
    const drySize = textureSizeAdjust(base, dry, 1);
    assert.ok(wetSize > base, '웻 보드는 기본 사이즈보다 커야 함');
    assert.ok(drySize < base, '드라이 보드는 기본 사이즈보다 작아야 함');
    assert.ok(wetSize > drySize);
  });

  check('textureBluffAdjust: 드라이한 보드일수록 블러프 빈도가 높아짐', () => {
    const wet = classifyBoardTexture(cards(['7s', '8s', '9s']));
    const dry = classifyBoardTexture(cards(['2s', '9h', 'Kc']));
    const base = 0.1;
    assert.ok(textureBluffAdjust(base, dry, 1) > base);
    assert.ok(textureBluffAdjust(base, wet, 1) < base);
  });

  check('exploitAdjustments: opponentModel/weight가 없으면 중립값(조정 없음)', () => {
    const adj = exploitAdjustments(null, [1], 1);
    assert.deepStrictEqual(adj, { bluffMult: 1, valueMult: 1, callLooseness: 0 });
  });

  check('exploitAdjustments: 폴드를 잘하는 상대에게는 블러프 배수를 올리고 밸류 배수를 내림', () => {
    const model = { foldToBetRate: () => 0.8, aggressionRate: () => null };
    const adj = exploitAdjustments(model, [1], 1);
    assert.ok(adj.bluffMult > 1, `폴드 잘하는 상대에게는 블러프를 늘려야 함 (실제: ${adj.bluffMult})`);
    assert.ok(adj.valueMult < 1, `폴드 잘하는 상대에게는 밸류벳을 굳이 키울 필요가 없음 (실제: ${adj.valueMult})`);
  });

  check('exploitAdjustments: 콜스테이션(폴드를 잘 안 함)에게는 블러프를 줄이고 밸류를 키움', () => {
    const model = { foldToBetRate: () => 0.15, aggressionRate: () => null };
    const adj = exploitAdjustments(model, [1], 1);
    assert.ok(adj.bluffMult < 1);
    assert.ok(adj.valueMult > 1);
  });

  check('멀티스트리트 플랜(지연 블러프): 도래한 스트리트에 계획대로 베팅을 강행하고, 사용 후 계획을 지움', () => {
    const board = cards(['2s', '9h', 'Kc', '4d']); // 턴까지 진행된 보드, 히어로는 아주 약한 패
    const eng = fakeEngine({
      street: 'turn',
      board,
      heroCards: cards(['7c', '2h']),
      aiPlan: { type: 'delayedBluff', dueStreet: 'turn' },
    });
    const legal = { callAmount: 0, canCheck: true, canCall: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 5000, stack: 2000 };
    const rng = constRng(0.01); // 어떤 확률 분기든 "일어나는 쪽"으로 결정적으로 고정
    const decision = decidePostflop(eng, 0, legal, { rng, skillLevel: 70 });
    assert.strictEqual(decision.actionType, 'raise', '지연 블러프 계획이 있으면 약한 패라도 이번 스트리트에 베팅을 강행해야 함');
    assert.strictEqual(eng.hs[0].aiPlan, null, '계획은 한 번 쓰이면(도래한 스트리트에 도달하면) 지워져야 함');
  });

  check('멀티스트리트 플랜(지연 블러프): 계획의 대상 스트리트가 아니면 적용되지 않고 그냥 지워짐', () => {
    const board = cards(['2s', '9h', 'Kc']);
    const eng = fakeEngine({
      street: 'flop',
      board,
      heroCards: cards(['7c', '2h']),
      aiPlan: { type: 'delayedBluff', dueStreet: 'turn' }, // 아직 턴이 아님
    });
    const legal = { callAmount: 0, canCheck: true, canCall: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 5000, stack: 2000 };
    // rng를 아주 크게 고정해서, "계획이 아니었다면 통상적인 블러프/플랜설정 확률" 자체가 전부
    // 실패하도록 만든다 - 그래야 혹시 계획이 잘못 적용됐는지(강제 베팅) 아닌지가 명확히 갈린다.
    const rng = constRng(0.99);
    const decision = decidePostflop(eng, 0, legal, { rng, skillLevel: 70 });
    assert.strictEqual(decision.actionType, 'check', '대상 스트리트가 아직 아니므로 강제 베팅이 일어나선 안 됨');
    assert.strictEqual(eng.hs[0].aiPlan, null, '스트리트가 맞지 않는 낡은 계획도 소비(제거)되어야 함');
  });

  check('멀티스트리트 플랜(슬로우플레이): 계획이 있으면 상대 베팅에 콜 대신 체크레이즈로 대응', () => {
    const board = cards(['2s', '9h', 'Kc', '4d']);
    // 히어로에게 압도적으로 강한 패(투페어/셋 등)를 줘서 실제로도 이 상황에서 레이즈가
    // 정당화되는 이퀴티가 나오도록 함(순수 강제가 아니라 "그럴 만한" 상황에서의 플랜 실현)
    const eng = fakeEngine({
      street: 'turn',
      board,
      heroCards: cards(['9s', '9c']), // 보드에 9가 하나 더 있어 세트
      aiPlan: { type: 'slowplay', dueStreet: 'turn' },
    });
    const legal = { callAmount: 200, canCheck: false, canCall: true, canRaise: true, minRaiseTo: 600, maxRaiseTo: 5000, stack: 3000 };
    const rng = constRng(0.01);
    const decision = decidePostflop(eng, 0, legal, { rng, skillLevel: 70 });
    assert.strictEqual(decision.actionType, 'raise', '슬로우플레이 계획이 실현되면 콜만 하지 않고 체크레이즈로 되받아쳐야 함');
    assert.strictEqual(eng.hs[0].aiPlan, null);
  });

  check('상대 레인지 추정: skillLevel이 낮으면(rangeWeight=0) 이번 핸드 프리플랍 액션과 무관하게 동일 로직으로 동작(크래시 없음)', () => {
    const board = cards(['2s', '9h', 'Kc']);
    const eng = fakeEngine({
      street: 'flop',
      board,
      heroCards: cards(['Ah', 'Qd']),
      actionLog: [{ seatIndex: 1, street: 'preflop', actionType: 'raise', amount: 300, toCallBefore: 0 }],
    });
    const legal = { callAmount: 0, canCheck: true, canCall: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 5000, stack: 2000 };
    const rng = seedRng(7);
    assert.doesNotThrow(() => decidePostflop(eng, 0, legal, { rng, skillLevel: 5 }));
  });

  check('상대 레인지 추정: skillLevel이 높아도(rangeWeight>0) 크래시 없이 정상 동작', () => {
    const board = cards(['2s', '9h', 'Kc']);
    const eng = fakeEngine({
      street: 'flop',
      board,
      heroCards: cards(['Ah', 'Qd']),
      actionLog: [{ seatIndex: 1, street: 'preflop', actionType: 'raise', amount: 300, toCallBefore: 0 }],
    });
    const legal = { callAmount: 0, canCheck: true, canCall: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 5000, stack: 2000 };
    const rng = seedRng(7);
    assert.doesNotThrow(() => decidePostflop(eng, 0, legal, { rng, skillLevel: 100 }));
  });

  check('멀티스트리트 플랜 생성: 실력이 높고 아주 강한 패로 체크 상황이 반복되면, 여러 번 중 최소 한 번은 슬로우플레이 계획이 세워짐', () => {
    // 완전한 무작위성 대신 시드 고정 PRNG로 여러 트라이얼을 돌려 "메커니즘이 실제로 발동
    // 가능한지"를 확인하는 통계적 스모크 테스트 (정확한 확률값 자체를 검증하진 않음).
    const board = cards(['Ks', 'Kh', '2c']); // 히어로가 셋을 완성해 이퀴티가 매우 높은 보드
    const legal = { callAmount: 0, canCheck: true, canCall: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 5000, stack: 2000 };
    let planSetCount = 0;
    for (let trial = 0; trial < 60; trial++) {
      const eng = fakeEngine({
        street: 'flop',
        board,
        heroCards: cards(['Kc', '7d']), // 트리플 킹
        opponentSeats: [1],
      });
      const rng = seedRng(1000 + trial);
      decidePostflop(eng, 0, legal, { rng, skillLevel: 100 });
      if (eng.hs[0].aiPlan && eng.hs[0].aiPlan.type === 'slowplay') planSetCount++;
    }
    assert.ok(planSetCount > 0, `${60}번 중 슬로우플레이 계획이 최소 한 번은 세워졌어야 함 (실제: ${planSetCount}번)`);
  });

  console.log(`AI 고급 전략(레인지 추정/보드텍스처/익스플로잇/멀티스트리트): ${n}개 테스트 통과`);
}

module.exports = { run };
