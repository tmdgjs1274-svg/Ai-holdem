'use strict';

const assert = require('assert');
const { summarizePreflopAction, rangeBoundsForTag, buildOpponentRangeFilters } = require('../src/ai/RangeModel');
const { cardFromString } = require('../src/game/Deck');

// 3인 테이블, 헤즈업이 아닌 기본 순서: [SB, BB, BTN]
function fakeEngine(actionLog) {
  return {
    actionLog,
    handSeatsInOrder: () => [0, 1, 2],
  };
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('actionLog가 비어있으면(정보 없음) null 반환', () => {
    const eng = fakeEngine([]);
    assert.strictEqual(summarizePreflopAction(eng, 0), null);
  });

  check('레이즈 한 번만 했으면 raiser', () => {
    const eng = fakeEngine([{ seatIndex: 0, street: 'preflop', actionType: 'raise' }]);
    assert.strictEqual(summarizePreflopAction(eng, 0), 'raiser');
  });

  check('레이즈 두 번(3벳 이상) 했으면 reraiser', () => {
    const eng = fakeEngine([
      { seatIndex: 0, street: 'preflop', actionType: 'raise' },
      { seatIndex: 1, street: 'preflop', actionType: 'raise' },
      { seatIndex: 0, street: 'preflop', actionType: 'raise' },
    ]);
    assert.strictEqual(summarizePreflopAction(eng, 0), 'reraiser');
  });

  check('콜만 했으면 caller', () => {
    const eng = fakeEngine([{ seatIndex: 0, street: 'preflop', actionType: 'call' }]);
    assert.strictEqual(summarizePreflopAction(eng, 0), 'caller');
  });

  check('체크만 했으면(빅블라인드 무료 체크 등) checked_through', () => {
    const eng = fakeEngine([{ seatIndex: 0, street: 'preflop', actionType: 'check' }]);
    assert.strictEqual(summarizePreflopAction(eng, 0), 'checked_through');
  });

  check('postflop 액션은 프리플랍 요약에서 제외됨', () => {
    const eng = fakeEngine([{ seatIndex: 0, street: 'flop', actionType: 'raise' }]);
    assert.strictEqual(summarizePreflopAction(eng, 0), null);
  });

  check('레인지 임계값: reraiser > raiser > caller 순으로 최소 점수가 높아짐', () => {
    const eng = fakeEngine([]);
    const rReraiser = rangeBoundsForTag(eng, 0, 'reraiser');
    const rRaiser = rangeBoundsForTag(eng, 0, 'raiser');
    const rCaller = rangeBoundsForTag(eng, 0, 'caller');
    assert.ok(rReraiser.min > rRaiser.min, 'reraiser 최소점수가 raiser보다 높아야 함');
    assert.ok(rRaiser.min >= rCaller.min, 'raiser 최소점수가 caller보다 높거나 같아야 함');
  });

  check('rangeWeight<=0이면 필터를 전혀 만들지 않음(null)', () => {
    const eng = fakeEngine([{ seatIndex: 1, street: 'preflop', actionType: 'raise' }]);
    const filters = buildOpponentRangeFilters(eng, [1], 0, () => 0);
    assert.strictEqual(filters, null);
  });

  check('rangeWeight=1(rng이 항상 적용 허용)이면 프리플랍 정보가 있는 상대에게 필터가 생김', () => {
    const eng = fakeEngine([{ seatIndex: 1, street: 'preflop', actionType: 'raise' }]);
    const filters = buildOpponentRangeFilters(eng, [1], 1, () => 0); // rng()=0이면 항상 적용 허용
    assert.ok(Array.isArray(filters));
    assert.strictEqual(typeof filters[0], 'function');
  });

  check('만들어진 필터는 실제로 약한 손패를 걸러내고 강한 손패는 통과시킴', () => {
    const eng = fakeEngine([{ seatIndex: 1, street: 'preflop', actionType: 'raise' }]);
    const filters = buildOpponentRangeFilters(eng, [1], 1, () => 0);
    const filter = filters[0];
    const weak = [cardFromString('7c'), cardFromString('2d')]; // 아주 약한 오프수트
    const strong = [cardFromString('As'), cardFromString('Ks')]; // 아주 강한 수트 커넥터
    assert.strictEqual(filter(weak[0], weak[1]), false, '레이즈한 상대의 레인지에 7-2는 들어있지 않아야 함');
    assert.strictEqual(filter(strong[0], strong[1]), true, 'AK수트는 레이즈 레인지에 들어있어야 함');
  });

  check('아무도 프리플랍 정보가 없으면(전부 checked_through 등으로도 태그가 없으면) null', () => {
    const eng = fakeEngine([]); // 액션 로그 자체가 없음
    const filters = buildOpponentRangeFilters(eng, [1, 2], 1, () => 0);
    assert.strictEqual(filters, null);
  });

  console.log(`RangeModel: ${n}개 테스트 통과`);
}

module.exports = { run };
