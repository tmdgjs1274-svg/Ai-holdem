'use strict';

const assert = require('assert');
const { TableManager } = require('../src/session/TableManager');
const { decideAction } = require('../src/ai/AIDecisionEngine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// human 좌석도 자동으로 (AI 엔진을 빌려) 액션하게 해서 통합 테스트를 무인으로 돌린다.
// 핸드 종료 후 "다음 핸드 준비 완료" 확인 대기(awaitNextHand)도 즉시 자동으로 눌러준다.
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
  const readyHandler = () => {
    for (const playerId of humanPlayerIds) {
      try {
        table.handleReadyForNextHand(playerId);
      } catch (e) {
        // 무시
      }
    }
  };
  table.on('state', handler);
  table.on('awaitNextHand', readyHandler);
  return () => {
    table.off('state', handler);
    table.off('awaitNextHand', readyHandler);
  };
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
      aiActionDelayMs: 5,
    });
    const lobby = table.getLobbyState();
    assert.strictEqual(lobby.seats[0].type, 'human');
    assert.strictEqual(lobby.seats[1], null); // 게스트 슬롯 비어있음
    const aiSeated = lobby.seats.filter((s) => s && s.type === 'ai').length;
    assert.strictEqual(aiSeated, 3);
  });

  await check('게스트 합류: 좌석1에 착석, 풀이면 재합류 불가', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 2, startingStack: 2000, interHandDelayMs: 10,
      aiActionDelayMs: 5, levelDurationMinutes: 0 });
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
      aiActionDelayMs: 0, // 여러 핸드를 빠르게 돌려야 하는 테스트라 텀을 없앰
      aiAutoRebuy: true,
    });
    const totalBefore = table.engine.totalChipsOnTable();
    const stopAuto = autoDriveHumans(table, ['host1']);
    let handResults = 0;
    let rebuyChips = 0;
    table.on('handResult', () => { handResults++; });
    table.on('aiRebuy', ({ stack }) => { rebuyChips += stack; }); // 근사치(리바인 시점 스택 전액 아님이라 상한선 개념으로만 사용
    // 호스트(사람)도 짧지 않은 스택이지만 여러 핸드를 빠르게 돌리다 보면 드물게 파산할 수 있다.
    // 응답 없는 리바인 요청 때문에 테스트가 멈추지 않도록 즉시 수락해준다.
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'host1') table.handleRebuyDecision('host1', true);
    });
    table.start();
    await wait(1500); // 여러 핸드가 자동 진행될 시간을 줌
    stopAuto();
    assert.ok(handResults >= 3, `핸드가 충분히 진행되어야 함 (실제: ${handResults})`);
    // 측정 시점에 핸드가 한창 "진행 중"일 수 있으므로(베팅된 칩이 아직 stack이 아니라 팟에 있는 상태)
    // 그 경우에만 현재 팟(미정산 베팅액)을 더해야 한다. 핸드가 이미 쇼다운/폴드로 종료되어 팟이
    // 승자 스택에 정산된 뒤라면 committedThisHand는 다음 핸드 시작 전까지 남아있는 "낡은" 기록일
    // 뿐이라 더하면 이미 지급된 상금을 중복으로 세게 된다(진짜 버그가 아니라 계측 오류였음).
    const handInFlight = table.engine.street !== 'showdown' && table.engine.street !== 'idle';
    const totalAfter = table.engine.totalChipsOnTable() + (handInFlight ? table.engine.potNow() : 0);
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
      startingStack: 60, // 아주 짧은 스택으로 빠르게 파산 유도 (거의 매 핸드 올인 상황)
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 2,
      aiActionDelayMs: 2,
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
    // 매 핸드가 사실상 올인 코인플립이라 충분히 많은 핸드를 돌리면 호스트가 거의 확실히 파산함
    await wait(4000);
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
      aiActionDelayMs: 5,
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
    // 게스트가 초반 올인을 우연히 이겨 스택이 불어나면 파산까지 오래 걸려 테스트가 느려질 수 있으므로,
    // (아직 파산 전이라면) 매 핸드가 끝날 때마다 다시 짧은 스택으로 눌러줘서 매 핸드 올인을 강제한다.
    table.on('handResult', () => {
      const seat = table.engine.seats[1];
      if (seat && seat.stack > 55) seat.stack = 55;
    });
    table.start();
    await wait(3000);
    stopAuto();
    assert.strictEqual(guestLeft, true, '게스트 퇴장 이벤트 발생');
    assert.strictEqual(roomClosed, false, '방은 종료되지 않아야 함');
    assert.strictEqual(table.status, 'in_progress', '게임은 계속 진행 중이어야 함');
    assert.strictEqual(table.engine.seats[1], null, '게스트 좌석은 비워져야 함');
    table._closeRoom('test done');
  });

  await check('최대 리바인 횟수 초과 시 자동으로 탈락 처리(게스트)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 1,
      rebuyAmount: 55, // 리바인해도 다시 짧은 스택이라 금방 재파산하도록 함
    });
    table.addGuest('guest1', 'Guest');
    table.engine.seats[1].stack = 55; // 빠른 파산 유도

    const stopAuto = autoDriveHumans(table, ['host1', 'guest1']);
    let rebuyPrompts = 0;
    let forcedLeave = false;
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'guest1') {
        rebuyPrompts++;
        table.handleRebuyDecision('guest1', true); // 매번 수락 (그래도 상한을 넘으면 자동 탈락해야 함)
      }
    });
    table.on('rebuyResult', ({ seatIndex, accepted, reason }) => {
      if (seatIndex === 1 && !accepted && reason === 'maxRebuysReached') forcedLeave = true;
    });
    // 게스트가 매 핸드 올인을 강제받도록 (파산 전) 스택을 계속 짧게 눌러줘서 통계적 지연을 줄인다.
    table.on('handResult', () => {
      const seat = table.engine.seats[1];
      if (seat && seat.stack > 55) seat.stack = 55;
    });
    table.start();
    await wait(5000);
    stopAuto();
    assert.strictEqual(forcedLeave, true, 'maxRebuys 초과 후 자동 탈락 처리되어야 함');
    assert.strictEqual(rebuyPrompts, 1, '최대 1회(maxRebuys=1)까지만 리바인 프롬프트가 떠야 함');
    table._closeRoom('test done');
  });

  await check('애드온: 설정된 금액만큼 1회 지급, 재사용 불가', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      addOnAmount: 500,
    });
    table.start();
    const before = table.engine.seats[0].stack;
    table.useAddOn('host1');
    assert.strictEqual(table.engine.seats[0].stack, before + 500);
    assert.throws(() => table.useAddOn('host1'), /이미 애드온/);
    table._closeRoom('test done');
  });

  await check('로비에서 호스트가 설정 변경 가능 (AI 인원수, 블라인드 등)', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 2, startingStack: 3000, levelDurationMinutes: 0 });
    table.updateConfig('host1', { aiCount: 4, startSb: 100, startBb: 200, aiActionDelayMs: 1234 });
    const lobby = table.getLobbyState();
    const aiSeated = lobby.seats.filter((s) => s && s.type === 'ai').length;
    assert.strictEqual(aiSeated, 4);
    assert.strictEqual(table.blinds.levels[0].sb, 100);
    assert.strictEqual(table.blinds.levels[0].bb, 200);
    assert.strictEqual(table.config.aiActionDelayMs, 1234);
    assert.throws(() => table.updateConfig('guest-imposter', { aiCount: 1 }), /호스트만/);
  });

  await check('게임 진행 중에는 aiCount/startingStack 같은 항목은 변경되지 않음(화이트리스트)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 2,
      startingStack: 3000,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
    });
    table.start();
    const aiCountBefore = table.config.aiCount;
    table.updateConfig('host1', { aiCount: 6, aiMistakeRate: 0.2 });
    assert.strictEqual(table.config.aiCount, aiCountBefore, '진행 중에는 aiCount가 바뀌면 안 됨');
    assert.strictEqual(table.config.aiMistakeRate, 0.2, 'aiMistakeRate는 진행 중에도 변경 가능해야 함');
    table._closeRoom('test done');
  });

  await check('AI 액션이 playerAction 이벤트로 전달됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 3,
      startingStack: 3000,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
    });
    let actionEvents = 0;
    table.on('playerAction', () => { actionEvents++; });
    table.start();
    await wait(500);
    assert.ok(actionEvents > 0, 'AI 액션이 최소 1회 이상 playerAction으로 전달되어야 함');
    table._closeRoom('test done');
  });

  await check('사람이 폴드하지 않고 핸드가 끝나면 결과 확인 대기(awaitNextHand) 후 진행', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
    });
    let awaitCount = 0;
    let handEnded = false;
    table.on('awaitNextHand', () => { awaitCount++; });
    table.on('handResult', (result) => {
      handEnded = true;
      assert.strictEqual(typeof result.requiresConfirm, 'boolean', 'handResult에 requiresConfirm 플래그가 있어야 함');
    });
    // 호스트는 폴드하지 않고 체크/콜만 하도록 강제 (다음 핸드 준비 확인 대기는 수동으로만 처리)
    const forceHostActive = () => {
      const st = table.engine;
      if (st.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = st.seats[st.actingSeat];
      if (!seat || seat.playerId !== 'host1') return;
      const legal = st.getLegalActions(st.actingSeat);
      if (!legal) return;
      const action = legal.canCheck ? 'check' : legal.canCall ? 'call' : 'allin';
      try {
        table.handleAction('host1', action, 0);
      } catch (e) {
        // 무시
      }
    };
    table.on('state', forceHostActive);
    table.start();
    await wait(400);
    assert.strictEqual(handEnded, true, '핸드가 한 번은 끝나야 함');
    const handNumberBefore = table.engine.handNumber;
    await wait(500);
    // 사람이 계속 살아있었다면 확인 없이는 다음 핸드로 넘어가지 않아야 함(호스트가 아직 살아있는 한)
    if (awaitCount > 0) {
      assert.strictEqual(table.engine.handNumber, handNumberBefore, '준비 확인 전에는 다음 핸드로 넘어가면 안 됨');
      table.handleReadyForNextHand('host1');
      await wait(200);
      assert.ok(table.engine.handNumber > handNumberBefore, '모두 준비 완료하면 다음 핸드로 진행되어야 함');
    }
    table._closeRoom('test done');
  });

  await check('AI도 리바인 최대 횟수를 넘으면 자동 리바인을 멈춤', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      startSb: 25,
      startBb: 50,
      levelDurationMinutes: 0,
      interHandDelayMs: 5,
      aiActionDelayMs: 0,
      aiAutoRebuy: true,
      maxRebuys: 1,
      rebuyAmount: 55,
    });
    table.engine.seats[2].stack = 55; // AI를 짧은 스택으로 빠르게 파산시킴 (좌석1은 게스트 전용이라 AI는 좌석2)
    const stopAuto = autoDriveHumans(table, ['host1']);
    // 이 테스트의 maxRebuys는 호스트에게도 공통 적용되므로, 호스트가 파산해도 테스트가 멈추지 않게 처리
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'host1') table.handleRebuyDecision('host1', true);
    });
    table.start();
    await wait(2000);
    stopAuto();
    const aiRebuys = table.rebuyCounts[2] || 0;
    assert.ok(aiRebuys <= 1, `AI 리바인은 maxRebuys(1)를 넘지 않아야 함 (실제: ${aiRebuys})`);
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
