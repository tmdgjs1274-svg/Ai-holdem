'use strict';

const assert = require('assert');
const { quickStrength, classifyAction, buildWeightedRange, lineText } = require('../src/ai/LineReader');
const { estimateEquity } = require('../src/ai/Equity');
const { cardFromString: cf } = require('../src/game/Deck');

const cards = (s) => s.split(' ').map(cf);

// 가짜 엔진: 히어로(0) vs 상대(1). actionLog로 상대의 행동 흐름을 준다.
function fakeEngine(board, actionLog) {
  return {
    board: cards(board),
    actionLog,
    handSeatsInOrder: () => [0, 1],
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run() {
  let n = 0;
  const check = (label, fn) => { fn(); n++; console.log(`  ok - ${label}`); };

  check('quickStrength: 패 상태 분류(강한 패/애매한 패/드로우/아무것도 없음)', () => {
    const board = cards('Kh 7d 2c');
    assert.strictEqual(quickStrength(cards('Ks Qs'), board), 'strong'); // 탑페어 좋은 키커
    assert.strictEqual(quickStrength(cards('Ks 4s'), board), 'medium'); // 탑페어 약한 키커
    assert.strictEqual(quickStrength(cards('7s 6s'), board), 'medium'); // 세컨페어
    assert.strictEqual(quickStrength(cards('As Ad'), board), 'strong'); // 오버페어
    assert.strictEqual(quickStrength(cards('5s 5d'), board), 'medium'); // 보드보다 낮은 포켓페어
    assert.strictEqual(quickStrength(cards('7s 7h'), board), 'strong'); // 셋
    assert.strictEqual(quickStrength(cards('Qs Js'), board), 'weak'); // 아무것도 없음
    assert.strictEqual(quickStrength(cards('Ah 5h'), cards('Kh 7h 2c')), 'draw'); // 플러시 드로우
    assert.strictEqual(quickStrength(cards('9s 8s'), cards('Kh 7d 6c')), 'draw'); // 양방향 스트레이트 드로우
    assert.strictEqual(quickStrength(cards('9s 8s'), cards('Kh 7d 6c 5d')), 'strong'); // 스트레이트 완성
    assert.strictEqual(quickStrength(cards('Ah 5h'), cards('Kh 7h 2c 3d 9s')), 'weak'); // 리버에 못 맞춘 드로우 = 아무것도 없음
  });

  check('classifyAction: 체크/콜/작은 베팅/큰 베팅(팟의 60% 이상)/레이즈 구분', () => {
    assert.strictEqual(classifyAction({ actionType: 'check' }), 'check');
    assert.strictEqual(classifyAction({ actionType: 'call', toCallBefore: 300 }), 'call');
    assert.strictEqual(classifyAction({ actionType: 'bet', amount: 300, potBefore: 1000, toCallBefore: 0 }), 'betSmall');
    assert.strictEqual(classifyAction({ actionType: 'bet', amount: 800, potBefore: 1000, toCallBefore: 0 }), 'betBig');
    assert.strictEqual(classifyAction({ actionType: 'raise', amount: 2000, potBefore: 1600, toCallBefore: 600 }), 'raise');
    assert.strictEqual(classifyAction({ actionType: 'allin', amount: 400, toCallBefore: 600 }), 'call'); // 콜 금액보다 적은 올인 = 콜
    assert.strictEqual(classifyAction({ actionType: 'fold' }), null);
  });

  check('베팅 흐름 반영: 큰 베팅을 이어간 상대는 강한 패 비중↑, 계속 체크한 상대는 강한 패 비중↓', () => {
    const board = 'Kh 7d 2c 9s';
    const dead = cards('As Ac ' + board);
    const passive = buildWeightedRange(fakeEngine(board, [
      { seatIndex: 1, street: 'flop', actionType: 'check', toCallBefore: 0 },
      { seatIndex: 1, street: 'turn', actionType: 'check', toCallBefore: 0 },
    ]), 1, dead, {});
    const aggressive = buildWeightedRange(fakeEngine(board, [
      { seatIndex: 1, street: 'flop', actionType: 'bet', amount: 800, potBefore: 1000, toCallBefore: 0 },
      { seatIndex: 1, street: 'turn', actionType: 'bet', amount: 2000, potBefore: 2600, toCallBefore: 0 },
    ]), 1, dead, {});
    const none = buildWeightedRange(fakeEngine(board, []), 1, dead, {});
    assert.ok(aggressive.shares.strong > none.shares.strong * 1.5, `큰 베팅 2번 후 강한 패 비중이 크게 늘어야 함(${aggressive.shares.strong} vs ${none.shares.strong})`);
    assert.ok(passive.shares.strong < none.shares.strong, '체크만 한 상대는 강한 패 비중이 줄어야 함');
    assert.ok(aggressive.shares.medium < none.shares.medium, '큰 베팅은 애매한 패 비중을 줄여야 함(양극화)');
    assert.ok(aggressive.shares.weak > 0.05, '큰 베팅에도 허세(아무것도 없는 패)는 일부 남아야 함');
    assert.strictEqual(lineText(aggressive.line), '플랍 큰 베팅 → 턴 큰 베팅');
  });

  check('상대 성향 반영: 평소 공격적인 상대(bluffAdj>1)의 베팅에는 허세 비중이 더 크다', () => {
    const board = 'Kh 7d 2c';
    const dead = cards('As Ac ' + board);
    const log = [{ seatIndex: 1, street: 'flop', actionType: 'bet', amount: 800, potBefore: 1000, toCallBefore: 0 }];
    const normal = buildWeightedRange(fakeEngine(board, log), 1, dead, { bluffAdj: 1 });
    const maniac = buildWeightedRange(fakeEngine(board, log), 1, dead, { bluffAdj: 1.6 });
    assert.ok(maniac.shares.weak > normal.shares.weak);
  });

  check('이길 확률 계산에 반영: 같은 패라도 상대가 큰 베팅을 이어가면 이길 확률이 낮아진다', () => {
    // 히어로: 탑페어 약한 키커(K4) - 상대가 계속 크게 베팅하면 더 좋은 패가 많다고 봐야 함
    const board = 'Kh 7d 2c 9s';
    const hero = cards('Ks 4d');
    const dead = [...hero, ...cards(board)];
    const aggressive = buildWeightedRange(fakeEngine(board, [
      { seatIndex: 1, street: 'flop', actionType: 'bet', amount: 800, potBefore: 1000, toCallBefore: 0 },
      { seatIndex: 1, street: 'turn', actionType: 'bet', amount: 2000, potBefore: 2600, toCallBefore: 0 },
    ]), 1, dead, {});
    const flat = buildWeightedRange(fakeEngine(board, []), 1, dead, {});
    const eqAgg = estimateEquity(hero, cards(board), 1, mulberry32(7), 3000, null, [aggressive]);
    const eqFlat = estimateEquity(hero, cards(board), 1, mulberry32(7), 3000, null, [flat]);
    assert.ok(eqAgg < eqFlat - 0.08, `큰 베팅 흐름이면 이길 확률이 확실히 낮아야 함(${eqAgg.toFixed(2)} vs ${eqFlat.toFixed(2)})`);
  });

  console.log(`LineReader(상대 베팅 흐름 읽기): ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) run();
