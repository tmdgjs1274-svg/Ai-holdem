'use strict';

const assert = require('assert');
const { GameEngine, computePots } = require('../src/game/GameEngine');

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

    // 메인팟/사이드팟 구분이 정확한지도 함께 확인한다: 실제로 여러 팟이 만들어졌다면
    // (숏스택이 올인 -> 나머지 둘도 콜/올인이면 사이드팟이 생김), index 0은 항상 메인팟이고
    // mainWinnerSeats는 그 메인팟의 승자와 정확히 일치해야 한다.
    if (eng.lastHandResult.type === 'showdown' && eng.lastHandResult.pots.length > 1) {
      const pots = eng.lastHandResult.pots;
      assert.strictEqual(pots[0].isMain, true, '첫 번째 팟은 메인팟이어야 함');
      for (let i = 1; i < pots.length; i++) {
        assert.strictEqual(pots[i].isMain, false, `${i}번째 팟은 사이드팟이어야 함`);
      }
      assert.deepStrictEqual(
        [...eng.lastHandResult.mainWinnerSeats].sort(),
        [...pots[0].winners].sort(),
        'mainWinnerSeats는 메인팟(pots[0]) 승자와 정확히 일치해야 함'
      );
    }
  });

  check('벳/레이즈 라벨 구분: 이 스트리트에 아직 베팅이 없으면 "벳", 이미 베팅이 있으면 "레이즈"', () => {
    const eng = makeEngine(2, { rng: seedRng(5) });
    eng.startHand();
    // 프리플랍은 이미 빅블라인드(강제 베팅)가 있는 상태이므로, 첫 오픈레이즈도 관례상 "레이즈"로 남는다.
    let s = eng.actingSeat;
    const preflopRecords = [];
    eng.on('action', (r) => preflopRecords.push(r));
    eng.applyAction(s, 'raise', 150);
    assert.strictEqual(preflopRecords[0].actionType, 'raise', '프리플랍 오픈레이즈는 그대로 레이즈로 남아야 함');
    eng.applyAction(eng.actingSeat, 'call');
    assert.strictEqual(eng.street, 'flop');

    // 플랍(포스트플랍)에서는 이번 스트리트에 아직 아무도 베팅하지 않았으므로, 첫 액션은 "벳"이어야 한다.
    const flopRecords = [];
    eng.on('action', (r) => flopRecords.push(r));
    const better = eng.actingSeat;
    eng.applyAction(better, 'raise', eng.currentBet + eng.bigBlind); // 클라이언트/AI는 여전히 'raise'로 보냄
    assert.strictEqual(flopRecords[0].actionType, 'bet', '이 스트리트의 첫 베팅은 raise가 아니라 bet으로 기록되어야 함');

    // 그 다음 사람이 다시 올리면(이미 베팅이 있는 상태) 이건 진짜 "레이즈"여야 한다.
    const other = eng.actingSeat;
    eng.applyAction(other, 'raise', eng.currentBet + eng.bigBlind * 2);
    assert.strictEqual(flopRecords[1].actionType, 'raise', '이미 베팅이 있는 상태에서 올리는 건 레이즈여야 함');
  });

  check('actionLog: 이번 핸드의 액션이 street/toCallBefore와 함께 순서대로 쌓이고, 다음 핸드에서 초기화됨', () => {
    const eng = makeEngine(2, { rng: seedRng(5) });
    eng.startHand();
    const s1 = eng.actingSeat;
    eng.applyAction(s1, 'raise', 150); // 프리플랍 레이즈 (콜해야 할 금액이 있는 상태에서)
    assert.strictEqual(eng.actionLog.length, 1);
    assert.strictEqual(eng.actionLog[0].street, 'preflop');
    assert.strictEqual(eng.actionLog[0].actionType, 'raise');
    assert.ok(eng.actionLog[0].toCallBefore > 0, '레이즈 전에는 콜해야 할 금액이 있었어야 함');

    eng.applyAction(eng.actingSeat, 'call');
    assert.strictEqual(eng.street, 'flop');
    const better = eng.actingSeat;
    eng.applyAction(better, 'raise', eng.currentBet + eng.bigBlind); // 플랍 첫 베팅
    const betEntry = eng.actionLog[eng.actionLog.length - 1];
    assert.strictEqual(betEntry.street, 'flop');
    assert.strictEqual(betEntry.actionType, 'bet');
    assert.strictEqual(betEntry.toCallBefore, 0, '아무도 베팅하지 않은 상태에서의 첫 벳이므로 콜금액은 0이었어야 함');

    const lengthBeforeNextHand = eng.actionLog.length;
    assert.ok(lengthBeforeNextHand >= 3);

    // 남은 액션 마무리 후 다음 핸드로 넘어가면 actionLog가 새로 초기화되어야 한다.
    let guard = 0;
    while (eng.street !== 'showdown' && guard < 50) {
      guard++;
      const seat = eng.actingSeat;
      if (seat === -1) break;
      const legal = eng.getLegalActions(seat);
      if (legal.canCheck) eng.applyAction(seat, 'check');
      else if (legal.canCall) eng.applyAction(seat, 'call');
      else eng.applyAction(seat, 'fold');
    }
    eng.startHand();
    assert.deepStrictEqual(eng.actionLog, [], '새 핸드가 시작되면 actionLog는 비어있어야 함');
  });

  check('최소 레이즈 미만 요청 시 자동 보정(최소레이즈로 클램프)', () => {
    const eng = makeEngine(2);
    eng.startHand();
    const s = eng.actingSeat;
    // bb=50이므로 최소레이즈는 100(콜50+레이즈50). 60처럼 너무 작은 값을 넣어도 최소레이즈로 보정되어야 함
    eng.applyAction(s, 'raise', 60);
    assert.strictEqual(eng.currentBet, 100);
  });

  check('BB 앤티: 빅블라인드 좌석이 앤티를 내고(버튼/타플레이어는 안냄), 팟에 정상 반영', () => {
    const eng = makeEngine(3, { rng: seedRng(3) });
    eng.setBlinds(25, 50, 50); // 앤티 = BB와 동일 금액 (BB 앤티 포맷)
    const totalBefore = eng.totalChipsOnTable();
    eng.startHand();
    const bb = eng.bbIndex;
    // 빅블라인드는 정규 BB(50) + 앤티(50) = 100을 내야 함
    assert.strictEqual(eng.seats[bb].stack, 1000 - 100, '빅블라인드는 BB+앤티를 합쳐서 냄');
    // 빅블라인드가 아닌 좌석(버튼 포함)은 앤티를 내지 않음 (SB 포스팅 금액만 차감)
    for (const s of eng.seats) {
      if (!s || s.seatIndex === bb) continue;
      if (s.seatIndex === eng.sbIndex) assert.strictEqual(s.stack, 1000 - 25);
      else assert.strictEqual(s.stack, 1000, '버튼을 포함해 SB/BB가 아닌 좌석은 앤티를 내지 않음');
    }
    // 앤티는 스트리트 커밋액에 포함되지 않아야 함 (콜 금액 계산에 영향 없도록) -> BB의 스트리트
    // 커밋액은 정규 블라인드(50)만 남아야 하고, 앤티(50)는 committedThisHand에만 반영됨
    assert.strictEqual(eng.hs[bb].committedThisStreet, 50, 'BB의 스트리트 커밋액은 앤티를 제외한 정규 블라인드만이어야 함');
    assert.strictEqual(eng.hs[bb].committedThisHand, 100, 'BB의 핸드 전체 커밋액은 BB+앤티 합산이어야 함');
    // 스택 + 팟(committedThisHand 총합)이 시작 전 총량과 같아야 함 (칩 보존)
    const totalAfter = eng.totalChipsOnTable() + eng.potNow();
    assert.strictEqual(totalBefore, totalAfter, '칩 총량 보존 (앤티 포함, 스택+팟)');
  });

  check('폴드한 플레이어의 패는 쇼다운에서 본인 외에는 공개되지 않음', () => {
    const eng = makeEngine(3, { rng: seedRng(5) });
    eng.startHand();
    const s1 = eng.actingSeat;
    eng.applyAction(s1, 'fold');
    const foldedSeat = s1;
    // 나머지는 체크다운으로 쇼다운까지 진행
    let guard = 0;
    while (eng.street !== 'showdown' && guard < 200) {
      guard++;
      const s = eng.actingSeat;
      if (s === -1) break;
      const legal = eng.getLegalActions(s);
      if (legal.canCheck) eng.applyAction(s, 'check');
      else eng.applyAction(s, 'call');
    }
    assert.strictEqual(eng.street, 'showdown');
    // 다른 좌석 시점: 폴드한 사람 카드는 가려져야 함
    const otherSeatIndex = eng.seats.find((s) => s && s.seatIndex !== foldedSeat).seatIndex;
    const viewFromOther = eng.getPublicState(otherSeatIndex);
    const foldedFromOther = viewFromOther.seats.find((s) => s && s.seatIndex === foldedSeat);
    assert.deepStrictEqual(foldedFromOther.holeCards, ['??', '??']);
    // 본인 시점: 자신의 카드는 그대로 보임
    const viewFromSelf = eng.getPublicState(foldedSeat);
    const foldedFromSelf = viewFromSelf.seats.find((s) => s && s.seatIndex === foldedSeat);
    assert.strictEqual(foldedFromSelf.holeCards.length, 2);
    assert.notDeepStrictEqual(foldedFromSelf.holeCards, ['??', '??']);
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

  check('콜해야 할 금액이 0(무료 체크 상황, 예: BB 옵션)이면 폴드는 불가능해야 한다(체크로만 가능)', () => {
    const eng = makeEngine(2);
    eng.startHand();
    // 헤즈업 프리플랍: 버튼(SB)이 림프(콜)하면 BB 차례로 넘어오는데, 이때 BB는 더 낼 돈이
    // 없어(callAmount=0) 체크가 가능한 상황이다. 무료로 체크 가능한 상황에서 폴드까지 보여주면
    // 실수로 손패를 날리기 쉬우므로, 이 경우 canFold는 false여야 한다.
    const firstLegal = eng.getLegalActions(eng.actingSeat);
    eng.applyAction(eng.actingSeat, firstLegal.canCall ? 'call' : 'check', firstLegal.callAmount || 0);
    const bbLegal = eng.getLegalActions(eng.actingSeat);
    assert.strictEqual(bbLegal.canCheck, true);
    assert.strictEqual(bbLegal.callAmount, 0);
    assert.strictEqual(bbLegal.canFold, false, 'toCall=0(무료 체크) 상황에서는 canFold가 false여야 한다');
    assert.throws(() => eng.applyAction(eng.actingSeat, 'fold'), /폴드할 수 없는/);
  });

  check('실제로 레이즈에 직면했거나(콜 필요) 프리플랍에서 빅블라인드를 콜해야 하는 상황에서는 폴드가 가능해야 한다', () => {
    const eng = makeEngine(2);
    eng.startHand();
    // 헤즈업 프리플랍 첫 액션자(버튼=SB)는 빅블라인드를 콜해야 하는 입장이라 폴드가 가능해야 한다.
    const firstLegal = eng.getLegalActions(eng.actingSeat);
    assert.strictEqual(firstLegal.canCall, true);
    assert.strictEqual(firstLegal.canFold, true);

    // 상대가 레이즈한 뒤 폴드 가능 여부도 확인
    const eng2 = makeEngine(2);
    eng2.startHand();
    eng2.applyAction(eng2.actingSeat, 'raise', eng2.getLegalActions(eng2.actingSeat).minRaiseTo);
    const facingRaise = eng2.getLegalActions(eng2.actingSeat);
    assert.strictEqual(facingRaise.canCall, true);
    assert.strictEqual(facingRaise.canFold, true);
  });

  check('computePots: 폴드한 사람의 기여액이 더 적어서 생기는 레이어는 사이드팟이 아니라 하나로 합쳐져야 한다', () => {
    // 3인: A,B는 끝까지 겨루고 C는 프리플랍에 빅블라인드만 내고 폴드(기여액이 A,B보다 적음).
    // 겨루는 사람 구성(eligibleSeats)이 모든 레이어에서 [A,B]로 동일하므로 실제로는 승부가
    // 한 번뿐이다 - "메인팟+사이드팟"처럼 나뉘어 보이면 안 된다.
    const pots = computePots([
      { playerSeat: 0, amount: 500, folded: false },
      { playerSeat: 1, amount: 500, folded: false },
      { playerSeat: 2, amount: 50, folded: true },
    ]);
    assert.strictEqual(pots.length, 1, '겨루는 구성이 동일한 레이어는 하나의 팟으로 합쳐져야 함');
    assert.strictEqual(pots[0].amount, 1050);
    assert.deepStrictEqual(pots[0].eligibleSeats.slice().sort(), [0, 1]);
  });

  check('computePots: 숏스택 올인처럼 겨루는 구성이 실제로 달라지는 진짜 사이드팟은 그대로 분리되어야 한다', () => {
    const pots = computePots([
      { playerSeat: 0, amount: 100, folded: false }, // 올인(숏스택)
      { playerSeat: 1, amount: 500, folded: false },
      { playerSeat: 2, amount: 500, folded: false },
    ]);
    assert.strictEqual(pots.length, 2);
    assert.deepStrictEqual(pots[0].eligibleSeats.slice().sort(), [0, 1, 2]);
    assert.strictEqual(pots[0].amount, 300);
    assert.deepStrictEqual(pots[1].eligibleSeats.slice().sort(), [1, 2]);
    assert.strictEqual(pots[1].amount, 800);
  });

  console.log(`GameEngine: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
