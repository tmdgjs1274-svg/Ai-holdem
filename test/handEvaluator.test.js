'use strict';

const assert = require('assert');
const { evaluateBest, compareScore } = require('../src/game/HandEvaluator');
const { cardFromString } = require('../src/game/Deck');

function cs(str) {
  return str.split(' ').map(cardFromString);
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('로얄 플러시', () => {
    const h = evaluateBest(cs('As Ks Qs Js Ts'));
    assert.strictEqual(h.category, 9);
    assert.strictEqual(h.tiebreakers[0], 14);
  });

  check('포카드', () => {
    const h = evaluateBest(cs('7s 7h 7d 7c 2h'));
    assert.strictEqual(h.category, 8);
    assert.deepStrictEqual(h.tiebreakers, [7, 2]);
  });

  check('풀하우스', () => {
    const h = evaluateBest(cs('Ks Kh Kd 3s 3h'));
    assert.strictEqual(h.category, 7);
    assert.deepStrictEqual(h.tiebreakers, [13, 3]);
  });

  check('플러시 (스트레이트 아님)', () => {
    const h = evaluateBest(cs('2s 5s 9s Js Ks'));
    assert.strictEqual(h.category, 6);
  });

  check('스트레이트', () => {
    const h = evaluateBest(cs('5s 6h 7d 8c 9s'));
    assert.strictEqual(h.category, 5);
    assert.strictEqual(h.tiebreakers[0], 9);
  });

  check('휠 스트레이트 (A-2-3-4-5)', () => {
    const h = evaluateBest(cs('As 2h 3d 4c 5s'));
    assert.strictEqual(h.category, 5);
    assert.strictEqual(h.tiebreakers[0], 5);
  });

  check('트리플', () => {
    const h = evaluateBest(cs('7s 7h 7d Kc 2h'));
    assert.strictEqual(h.category, 4);
  });

  check('투페어', () => {
    const h = evaluateBest(cs('Ks Kh 3d 3c 9h'));
    assert.strictEqual(h.category, 3);
  });

  check('원페어', () => {
    const h = evaluateBest(cs('Ks Kh 3d 8c 9h'));
    assert.strictEqual(h.category, 2);
  });

  check('하이카드', () => {
    const h = evaluateBest(cs('2s 5h 9d Jc Ks'));
    assert.strictEqual(h.category, 1);
  });

  check('7장 중 최고 5장 선택 (플러시가 트리플보다 우선)', () => {
    // 홀카드 7s 7h, 보드 2s 5s 9s Js Ks -> 트리플(777) vs 플러시(2s5s9sJsKs) 중 플러시가 더 강함
    const h = evaluateBest(cs('7s 7h 2s 5s 9s Js Ks'));
    assert.strictEqual(h.category, 6);
  });

  check('7장 중 최고 5장 선택 (포카드 우선, 킥커 최댓값 선택)', () => {
    const h = evaluateBest(cs('7s 7h 7d 7c 2h Kc As'));
    assert.strictEqual(h.category, 8);
    assert.deepStrictEqual(h.tiebreakers, [7, 14]); // 킥커는 2가 아니라 A(14)여야 함
  });

  check('compareScore: 플러시 하이카드로 우열 가리기', () => {
    const a = evaluateBest(cs('2s 5s 9s Js Ks')); // K하이 플러시
    const b = evaluateBest(cs('2h 5h 9h Jh Qh')); // Q하이 플러시
    assert.ok(compareScore(a, b) > 0);
  });

  check('compareScore: 완전 동일한 5장 보드로 카드 5장씩 -> 무승부(kicker까지 동일)', () => {
    const board = cs('Ah Kh Qh Jh Th'); // 로얄 플러시가 보드에 그대로 있음
    const p1 = evaluateBest([...board, ...cs('2c 3d')]);
    const p2 = evaluateBest([...board, ...cs('4c 5d')]);
    assert.strictEqual(compareScore(p1, p2), 0);
  });

  console.log(`HandEvaluator: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
