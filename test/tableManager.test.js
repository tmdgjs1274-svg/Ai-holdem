'use strict';

const assert = require('assert');
const { TableManager } = require('../src/session/TableManager');
const { decideAction } = require('../src/ai/AIDecisionEngine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// human 좌석도 자동으로 (AI 엔진을 빌려) 액션하게 해서 통합 테스트를 무인으로 돌린다.
function autoDriveHumans(table, humanPlayerIds) {
  const handler = () => {
    const st = table.engine;
    if (st.actingSeat === -1 || table.status !== 'in_progress') return;
    const seat = st.seats[st.actingSeat];
    if (!seat || seat.type !== 'human') return;
    if (!humanPlayerIds.includes(seat.playerId)) return;
    const decision = decideAction(st, st.actingSeat, { mistakeRate: 0.08 });
    try {
      table.handleAction(seat.playerId, decision.actionType, decision.amount || 0);
    } catch (e) {
      // 타이밍 경합으로 이미 처리된 경우 무시
    }
  };
  table.on('state', handler);
  return () => table.off('state', handler);
}

async function run() {
  let n = 0;
  const check = async (label, fn) => {
    await fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  await check('로비 생성: 호스트 좌석0, AI가 나머지(게스트석 제외) 채움', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: '승헌',
      aiCount: 3,
      startingStack: 2000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
    });
    const lobby = table.getLobbyState();
    assert.strictEqual(lobby.seats[0].type, 'human');
    assert.strictEqual(lobby.seats[1], null); // 게스트 슬롯 비어있음
    const aiSeated = lobby.seats.filter((s) => s && s.type === 'ai').length;
    assert.strictEqual(aiSeated, 3);
  });

  await check('게스트 합류: 좌석1에 착석, 풀이면 재합류 불가', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 2, startingStack: 2000, interHandDelayMs: 10, levelDurationMinutes: 0 });
    const seatIdx = table.addGuest('guest1', '친구');
    assert.strictEqual(seatIdx, 1);
    assert.throws(() => table.addGuest('guest2', '친구2'));
  });

  await check('게임 진행: AI만 있는 경우 자동으로 여러 핸드 진행 + 칩 보존', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 4,
      startingStack: 3000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 15,
      aiAutoRebuy: true,
    });
    const totalBefore = table.engine.totalChipsOnTable();
    const stopAuto = autoDriveHumans(table, ['host1']);
    let handResults = 0;
    let rebuyChips = 0;
    table.on('handResult', () => { handResults++; });
    table.on('aiRebuy', ({ stack }) => { rebuyChips += stack; }); // 근사치(리바인 시점 스택 전액 아님이라 상한선 개념으로만 사용
    table.start();
    await wait(1500); // 여러 핸드가 자동 진행될 시간을 줌
    stopAuto();
    assert.ok(handResults >= 3, `핸드가 충분히 진행되어야 함 (실제: ${handResults})`);
    const totalAfter = table.engine.totalChipsOnTable();
    // AI 파산 시 자동 리바인으로 칩이 새로 투입되므로 총량은 "감소"는 절대 없어야 하고,
    // 오직 리바인 횟수 * 리바인액만큼만 증가해야 한다.
    assert.ok(totalAfter >= totalBefore, '칩 총량이 줄어들면 안 됨');
    const diff = totalAfter - totalBefore;
    assert.strictEqual(diff % 3000, 0, `증가분은 리바인액(3000)의 배수여야 함 (실제 diff: ${diff})`);
    table._closeRoom('test done');
  });

  await check('호스트 파산 후 리바인 거부 -> 방 종료', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 60, // 아주 짧은 스택으로 빠르게 파산 유도
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 15,
      aiAutoRebuy: true,
    });
    const stopAuto = autoDriveHumans(table, ['host1']);
    let closed = false;
    let closedReason = null;
    table.on('roomClosed', ({ reason }) => { closed = true; closedReason = reason; });
    table.on('rebuyRequired', ({ seatIndex, playerId }) => {
      if (playerId === 'host1') {
        // 호스트가 리바인을 거부한다고 가정
        table.handleRebuyDecision('host1', false);
      }
    });
    table.start();
    await wait(1500);
    stopAuto();
    assert.strictEqual(closed, true, '방이 종료되어야 함');
    assert.strictEqual(table.status, 'closed');
    assert.ok(closedReason.includes('리바인'));
  });

  await check('게스트 파산 후 리바인 거부 -> 게스트만 퇴장, 게임 계속', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 15,
      aiAutoRebuy: true,
    });
    table.addGuest('guest1', 'Guest');
    // 게스트만 매우 짧게 만들어 빨리 파산하도록 조정
    table.engine.seats[1].stack = 55;

    const stopAuto = autoDriveHumans(table, ['host1', 'guest1']);
    let guestLeft = false;
    let roomClosed = false;
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'guest1') {
        table.handleRebuyDecision('guest1', false);
      }
    });
    table.on('rebuyResult', ({ seatIndex, accepted }) => {
      if (seatIndex === 1 && !accepted) guestLeft = true;
    });
    table.on('roomClosed', () => { roomClosed = true; });
    table.start();
    await wait(1500);
    stopAuto();
    assert.strictEqual(guestLeft, true, '게스트 퇴장 이벤트 발생');
    assert.strictEqual(roomClosed, false, '방은 종료되지 않아야 함');
    assert.strictEqual(table.status, 'in_progress', '게임은 계속 진행 중이어야 함');
    assert.strictEqual(table.engine.seats[1], null, '게스트 좌석은 비워져야 함');
    table._closeRoom('test done');
  });

  console.log(`TableManager: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
