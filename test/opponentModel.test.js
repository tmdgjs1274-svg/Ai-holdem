'use strict';

const assert = require('assert');
const { OpponentModel } = require('../src/ai/OpponentModel');

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('표본(핸드/직면 횟수)이 부족하면 모든 통계가 null(판단 보류)', () => {
    const m = new OpponentModel();
    m.recordHandStart([0]);
    m.recordAction({ seatIndex: 0, street: 'preflop', actionType: 'raise', toCallBefore: 0 });
    assert.strictEqual(m.vpipRate(0), null);
    assert.strictEqual(m.foldToBetRate(0), null);
    assert.strictEqual(m.aggressionRate(0), null);
  });

  check('VPIP: 프리플랍에서 자발적으로 콜/레이즈한 핸드만 집계(체크/폴드는 제외)', () => {
    const m = new OpponentModel();
    for (let i = 0; i < 10; i++) m.recordHandStart([0]);
    // 5번은 레이즈(VPIP+PFR), 2번은 콜(VPIP만), 3번은 프리플랍 체크(VPIP 아님)
    for (let i = 0; i < 5; i++) m.recordAction({ seatIndex: 0, street: 'preflop', actionType: 'raise', toCallBefore: 0 });
    for (let i = 0; i < 2; i++) m.recordAction({ seatIndex: 0, street: 'preflop', actionType: 'call', toCallBefore: 100 });
    for (let i = 0; i < 3; i++) m.recordAction({ seatIndex: 0, street: 'preflop', actionType: 'check', toCallBefore: 0 });
    assert.strictEqual(m.vpipRate(0), 0.7, '7/10 핸드에서 자발적으로 돈을 넣었어야 함');
  });

  check('폴드 대응률: 베팅에 직면(toCallBefore>0)했을 때만 집계, 체크는 제외', () => {
    const m = new OpponentModel();
    for (let i = 0; i < 6; i++) m.recordAction({ seatIndex: 1, street: 'flop', actionType: 'fold', toCallBefore: 200 });
    for (let i = 0; i < 4; i++) m.recordAction({ seatIndex: 1, street: 'flop', actionType: 'call', toCallBefore: 200 });
    m.recordAction({ seatIndex: 1, street: 'turn', actionType: 'check', toCallBefore: 0 }); // 집계에 안 들어가야 함
    assert.strictEqual(m.foldToBetRate(1), 0.6, '10번 중 6번 폴드 = 0.6');
  });

  check('공격성: 베팅/레이즈 대 콜의 비율', () => {
    const m = new OpponentModel();
    for (let i = 0; i < 7; i++) m.recordAction({ seatIndex: 2, street: 'flop', actionType: 'raise', toCallBefore: 0 });
    for (let i = 0; i < 3; i++) m.recordAction({ seatIndex: 2, street: 'flop', actionType: 'call', toCallBefore: 100 });
    assert.strictEqual(m.aggressionRate(2), 0.7);
  });

  check('좌석이 다르면 통계도 분리되어 쌓임', () => {
    const m = new OpponentModel();
    for (let i = 0; i < 6; i++) m.recordAction({ seatIndex: 0, street: 'flop', actionType: 'fold', toCallBefore: 100 });
    for (let i = 0; i < 6; i++) m.recordAction({ seatIndex: 1, street: 'flop', actionType: 'call', toCallBefore: 100 });
    assert.strictEqual(m.foldToBetRate(0), 1);
    assert.strictEqual(m.foldToBetRate(1), 0);
  });

  console.log(`OpponentModel: ${n}개 테스트 통과`);
}

module.exports = { run };
