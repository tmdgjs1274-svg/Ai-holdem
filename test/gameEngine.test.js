'use strict';

const assert = require('assert');
const { GameEngine } = require('../src/game/GameEngine');

function seedRng(seed) {
  // 간단한 결정적 PRNG (mulberry32) - 테스트 재현성용
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeEngine(numPlayers, { stack = 1000, sb = 25, bb = 50, rng } = {}) {
  const eng = new GameEngine({ maxSeats: 9, rng: rng || seedRng(42) });
  eng.setBlinds(sb, bb);
  for (let i = 0; i < numPlayers; i++) {
    eng.seatPlayer(i, { playerId: `p${i}`, displayName: `P${i}`, type: 'ai', stack });
  }
  return eng;
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('헤즈업: 블라인드 포스팅 및 첫 액션자(버튼=SB)', () => {
    const eng = makeEngine(2);
    eng.startHand();
    assert.strictEqual(eng.actingSeat, eng.buttonIndex);
    assert.strictEqual(eng.seats[eng.sbIndex].stack, 1000 - 25);
    assert.strictEqual(eng.seats[eng.bbIndex].stack, 1000 - 50);
    assert.strictEqual(eng.currentBet, 50);
  });

  check('헤즈업: 콜-체크로 프리플랍 종료 후 플랍 진입', () => {
    const eng = makeEngine(2);
    eng.startHand();
    const sb = eng.actingSeat;
    eng.applyAction(sb, 'call');
    const legal = eng.getLegalActions(eng.actingSeat);
    assert.strictEqual(legal.canCheck, true);
    eng.applyAction(eng.actingSeat, 'check');
    assert.strictEqual(eng.street, 'flop');
    assert.strictEqual(eng.board.length, 3);
  });

  check('폴드로 핸드 종료: 팟 전체가 승자에게', () => {
    const eng = makeEngine(2);
    const totalBefore = eng.totalChipsOnTable();
    eng.startHand();
    const sb = eng.actingSeat;
    const bb = sb === eng.sbIndex ? eng.bbIndex : eng.sbIndex;
    eng.applyAction(sb, 'raise', 150);
    eng.applyAction(bb, 'fold');
    assert.strictEqual(eng.street, 'showdown');
    assert.strictEqual(eng.lastHandResult.type, 'fold');
    const totalAfter = eng.totalChipsOnTable();
    assert.strictEqual(totalBefore, totalAfter, '칩 총량 보존');
  });

  check('풀보드까지 진행 후 쇼다운 & 칩 보존 (체크다운)', () => {
    const eng = makeEngine(3, { rng: seedRng(7) });
    const totalBefore = eng.totalChipsOnTable();
    eng.startHand();
    // 프리플랍: UTG(첫 액션자) 콜, 다음 콜, BB 체크
    let guard = 0;
    while (eng.street !== 'showdown' && guard < 200) {
      guard++;
      const s = eng.actingSeat;
      const legal = eng.getLegalActions(s);
      if (legal.canCheck) eng.applyAction(s, 'check');
      else eng.applyAction(s, 'call');
    }
    assert.strictEqual(eng.street, 'showdown');
    assert.strictEqual(eng.board.length, 5);
    assert.ok(eng.lastHandResult.type === 'showdown');
    const totalAfter = eng.totalChipsOnTable();
    assert.strictEqual(totalBefore, totalAfter, '칩 총량 보존');
  });

  check('사이드팟: 숏스택 올인 + 두 명 콜 -> 팟 분리 및 칩 보존', () => {
    const eng = new GameEngine({ maxSeats: 9, rng: seedRng(11) });
    eng.setBlinds(25, 50);
    eng.seatPlayer(0, { playerId: 'p0', displayName: 'Short', type: 'ai', stack: 200 });
    eng.seatPlayer(1, { playerId: 'p1', displayName: 'Mid', type: 'ai', stack: 1000 });
    eng.seatPlayer(2, { playerId: 'p2', displayName: 'Big', type: 'ai', stack: 1000 });
    const totalBefore = eng.totalChipsOnTable();
    eng.startHand();

    // 첫 액션자가 올인
    let s = eng.actingSeat;
    eng.applyAction(s, 'allin');
    // 나머지 콜로 진행, 체크는 체크로
    let guard = 0;
    while (eng.street !== 'showdown' && guard < 200) {
      guard++;
      s = eng.actingSeat;
      if (s === -1) break;
      const legal = eng.getLegalActions(s);
      if (legal.canCheck) eng.applyAction(s, 'check');
      else if (legal.canCall) eng.applyAction(s, 'call');
      else eng.applyAction(s, 'allin');
    }
    assert.strictEqual(eng.street, 'showdown');
    const totalAfter = eng.totalChipsOnTable();
    assert.strictEqual(totalBefore, totalAfter, '칩 총량 보존 (사이드팟 포함)');
  });

  check('최소 레이즈 미만 요청 시 자동 보정(최소레이즈로 클램프)', () => {
    const eng = makeEngine(2);
    eng.startHand();
    const s = eng.actingSeat;
    // bb=50이므로 최소레이즈는 100(콜50+레이즈50). 60처럼 너무 작은 값을 넣어도 최소레이즈로 보정되어야 함
    eng.applyAction(s, 'raise', 60);
    assert.strictEqual(eng.currentBet, 100);
  });

  check('무작위 시뮬레이션 200핸드: 크래시 없음 + 칩 총량 항상 보존', () => {
    for (let trial = 0; trial < 20; trial++) {
      const numPlayers = 2 + (trial % 8); // 2~9명
      const rng = seedRng(1000 + trial);
      const eng = makeEngine(numPlayers, { stack: 2000, rng });
      const totalBefore = eng.totalChipsOnTable();

      for (let hand = 0; hand < 10; hand++) {
        // 파산자는 다음 핸드부터 제외
        for (const seat of eng.seats) {
          if (seat && seat.stack <= 0) seat.isSittingOut = true;
        }
        if (!eng.canStartHand()) break;
        eng.startHand();
        let guard = 0;
        while (eng.street !== 'showdown' && guard < 500) {
          guard++;
          const s = eng.actingSeat;
          if (s === -1) break;
          const legal = eng.getLegalActions(s);
          const roll = rng();
          if (roll < 0.15 && !legal.canCheck) {
            eng.applyAction(s, 'fold');
          } else if (roll < 0.55) {
            if (legal.canCheck) eng.applyAction(s, 'check');
            else if (legal.canCall) eng.applyAction(s, 'call');
            else eng.applyAction(s, 'allin');
          } else if (roll < 0.85 && legal.canRaise) {
            const raiseTo = legal.minRaiseTo + Math.floor(rng() * 100);
            eng.applyAction(s, 'raise', raiseTo);
          } else if (legal.canCall) {
            eng.applyAction(s, 'call');
          } else if (legal.canCheck) {
            eng.applyAction(s, 'check');
          } else {
            eng.applyAction(s, 'allin');
          }
          assert.ok(guard < 500, `무한루프 의심 (trial ${trial}, hand ${hand})`);
        }
        const totalNow = eng.totalChipsOnTable();
        assert.strictEqual(
          totalNow,
          totalBefore,
          `칩 총량 불일치 (trial ${trial}, hand ${hand}): ${totalNow} !== ${totalBefore}`
        );
      }
    }
  });

  console.log(`GameEngine: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
