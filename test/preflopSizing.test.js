'use strict';

const assert = require('assert');
const { sizePreflopRaise } = require('../src/ai/PreflopRanges');

function seedRng(seed) {
  // 간단한 결정적 PRNG (mulberry32) - 테스트 재현성용 (gameEngine.test.js와 동일)
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  const bb = 200;
  const engine = { bigBlind: bb, currentBet: bb }; // 언오픈 팟(=SB/BB 포스팅만 된 상태) 가정
  const legal = { minRaiseTo: bb * 2, maxRaiseTo: bb * 100 };

  check('오픈레이즈(raiseLevel=0)는 항상 2~3bb 사이로만 나옴(예전처럼 무조건 3bb로 고정되지 않음)', () => {
    const rng = seedRng(1);
    const positions = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const position = positions[i % positions.length];
      const ctx = { raiseLevel: 0, position };
      const raiseTo = sizePreflopRaise(engine, legal, ctx, rng);
      const mult = raiseTo / bb;
      assert.ok(mult >= 1.9 && mult <= 3.1, `오픈레이즈는 대략 2~3bb 사이여야 함 (실제: ${mult}bb)`);
      seen.add(raiseTo);
    }
    assert.ok(seen.size > 1, '무작위성과 포지션에 따라 오픈레이즈 사이즈가 다양하게 나와야 함(항상 3bb로 고정되면 안 됨)');
  });

  check('포지션별 기본 배수: BTN(늦은 포지션)은 UTG(이른 포지션)보다 평균적으로 더 작게 오픈함', () => {
    const rng = seedRng(2);
    const avg = (position, trials) => {
      let sum = 0;
      for (let i = 0; i < trials; i++) {
        sum += sizePreflopRaise(engine, legal, { raiseLevel: 0, position }, rng);
      }
      return sum / trials;
    };
    const utgAvg = avg('UTG', 300);
    const btnAvg = avg('BTN', 300);
    assert.ok(btnAvg < utgAvg, `BTN 평균(${btnAvg})이 UTG 평균(${utgAvg})보다 작아야 함`);
  });

  check('3벳 이상(raiseLevel>0)은 기존처럼 상대 베팅의 3배를 기준으로 함', () => {
    const rng = seedRng(3);
    const raisedEngine = { bigBlind: bb, currentBet: bb * 3 };
    const raiseTo = sizePreflopRaise(raisedEngine, legal, { raiseLevel: 1, position: 'BTN' }, rng);
    assert.strictEqual(raiseTo, bb * 9, '3벳 사이즈는 여전히 상대 베팅의 3배(600*3=1800)여야 함');
  });

  console.log(`PreflopRaiseSizing: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
