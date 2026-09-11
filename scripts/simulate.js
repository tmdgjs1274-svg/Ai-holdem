'use strict';

// AI끼리 자동으로 여러 핸드를 진행시켜 통계를 확인하는 유틸리티.
// 사용법: npm run simulate  (또는 node scripts/simulate.js [플레이어수] [핸드수])

const { GameEngine } = require('../src/game/GameEngine');
const { decideAction } = require('../src/ai/AIDecisionEngine');

function main() {
  const numPlayers = parseInt(process.argv[2], 10) || 6;
  const numHands = parseInt(process.argv[3], 10) || 500;
  const mistakeRate = 0.08;
  const startingStack = 10000;

  const eng = new GameEngine({ maxSeats: 9 });
  eng.setBlinds(25, 50);
  for (let i = 0; i < numPlayers; i++) {
    eng.seatPlayer(i, { playerId: `p${i}`, displayName: `P${i}`, type: 'ai', stack: startingStack });
  }

  let handsPlayed = 0;
  let vpipEvents = 0;
  let pfrEvents = 0;
  let playerHandCount = 0;
  const totalBefore = eng.totalChipsOnTable();

  for (let h = 0; h < numHands; h++) {
    if (!eng.canStartHand()) break;
    eng.startHand();
    const inHandSeats = eng.activePlayerSeats();
    const seatVpip = {};
    const seatPfr = {};

    let guard = 0;
    while (eng.street !== 'showdown' && guard < 1000) {
      guard++;
      const s = eng.actingSeat;
      if (s === -1) break;
      const wasPreflop = eng.street === 'preflop';
      const decision = decideAction(eng, s, { mistakeRate });
      if (wasPreflop) {
        if (['call', 'raise', 'allin'].includes(decision.actionType)) seatVpip[s] = true;
        if (['raise', 'allin'].includes(decision.actionType)) seatPfr[s] = true;
      }
      eng.applyAction(s, decision.actionType, decision.amount || 0);
    }
    if (guard >= 1000) {
      console.error(`핸드 ${h}에서 무한루프 의심 - 중단합니다`);
      break;
    }

    for (const seatIdx of inHandSeats) {
      playerHandCount++;
      if (seatVpip[seatIdx]) vpipEvents++;
      if (seatPfr[seatIdx]) pfrEvents++;
    }
    handsPlayed++;

    // 파산한 좌석은 다음 핸드를 위해 리바인(시뮬레이션 목적)
    for (const seat of eng.seats) {
      if (seat && seat.stack <= 0) seat.stack = startingStack;
    }
  }

  const totalAfter = eng.totalChipsOnTable();
  const rebuys = Math.round((totalAfter - totalBefore) / startingStack);

  console.log(`플레이어 수: ${numPlayers}, 진행된 핸드: ${handsPlayed}`);
  console.log(`VPIP: ${((vpipEvents / playerHandCount) * 100).toFixed(1)}%`);
  console.log(`PFR : ${((pfrEvents / playerHandCount) * 100).toFixed(1)}%`);
  console.log(`(참고: 리바인 ${rebuys}회 발생 - 정상적인 칩 증가이며 버그 아님)`);
}

main();
