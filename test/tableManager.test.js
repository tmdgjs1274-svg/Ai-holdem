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
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
    });
    const lobby = table.getLobbyState();
    assert.strictEqual(lobby.seats[0].type, 'human');
    assert.strictEqual(lobby.seats[1], null); // 게스트 슬롯 비어있음
    const aiSeated = lobby.seats.filter((s) => s && s.type === 'ai').length;
    assert.strictEqual(aiSeated, 3);
  });

  await check('게스트 합류: 낮은 인덱스 좌석부터 순서대로 착석, 완전히 풀이면 재합류 불가', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 8, // AI가 남은 좌석(1~8)을 전부 채움
      startingStack: 2000,
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
    });
    assert.strictEqual(table.isFull(), true, 'AI가 전 좌석을 채웠으므로 이미 풀 상태여야 함');
    assert.throws(() => table.addGuest('guest1', '친구'));
  });

  await check('최대 9명까지 사람이 순서대로 합류 가능(호스트 포함), 그 이상은 불가', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 0, // AI 없이 좌석 1~8을 사람에게 전부 개방
      startingStack: 2000,
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
    });
    assert.strictEqual(table.isFull(), false);
    for (let i = 1; i <= 8; i++) {
      const seatIdx = table.addGuest(`guest${i}`, `친구${i}`);
      assert.strictEqual(seatIdx, i, `게스트 ${i}는 좌석 ${i}에 앉아야 함(낮은 인덱스부터 순서대로)`);
    }
    assert.strictEqual(table.isFull(), true, '9명(호스트+게스트8명)이 다 찼으면 풀이어야 함');
    assert.throws(() => table.addGuest('guest9', '친구9'), '9명을 초과해 합류할 수 없어야 함');
  });

  await check('게임 시작 시 좌석 배치가 무작위로 섞여 입장 순서(호스트=0, AI=뒷자리)와 달라짐', async () => {
    // rng가 항상 0을 반환하도록 고정하면 Fisher-Yates가 결정적인 회전(rotation) 순열을
    // 만들어내므로, 실제로 좌석이 뒤섞였는지를 재현 가능하게 검증할 수 있다.
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 3,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 60000, // 검증 도중 AI가 먼저 액션해버리지 않도록 텀을 크게 둠
      rng: () => 0,
    });
    // 셔플 전: 호스트=0, AI는 맨 뒷자리(8,7,6)부터 채워짐 -> 점유 좌석은 [0,6,7,8]
    assert.strictEqual(table.engine.seats[0].playerId, 'host1');
    assert.strictEqual(table.engine.seats[6].type, 'ai');
    assert.strictEqual(table.engine.seats[7].type, 'ai');
    assert.strictEqual(table.engine.seats[8].type, 'ai');
    const seat8AiName = table.engine.seats[8].displayName;

    table.start();

    // rng=0 고정 시 [0,6,7,8] -> 각자 한 칸씩 회전한 배치([6,7,8,0])가 되어야 한다.
    assert.strictEqual(table.engine.seats[6].playerId, 'host1', '호스트가 좌석6으로 이동해야 함');
    assert.strictEqual(table.seatByPlayer['host1'], 6, 'seatByPlayer도 새 좌석을 가리켜야 함');
    assert.strictEqual(table.engine.seats[0].type, 'ai', '원래 좌석8에 있던 AI가 좌석0으로 이동해야 함');
    assert.strictEqual(table.engine.seats[0].displayName, seat8AiName);
    assert.strictEqual(table.engine.seats[7].type, 'ai', '원래 좌석6에 있던 AI가 좌석7로 이동해야 함');
    assert.strictEqual(table.engine.seats[8].type, 'ai', '원래 좌석7에 있던 AI가 좌석8로 이동해야 함');
    table._closeRoom('test done');
  });

  await check('shuffleSeatsOnStart:false로 끄면 예전처럼 입장 순서 그대로 좌석이 유지됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 2,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
      shuffleSeatsOnStart: false,
    });
    table.start();
    assert.strictEqual(table.engine.seats[0].playerId, 'host1', '셔플을 껐다면 호스트는 그대로 좌석0에 남아야 함');
    table._closeRoom('test done');
  });

  await check('접속 끊김 판정: 셔플로 좌석0에 온 게스트가 오래 끊겨도 방 전체가 아니라 그 게스트만 퇴장함(호스트 판정은 좌석번호가 아닌 playerId 기준)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 0,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
      rng: () => 0, // 고정 셔플: host1(원래 좌석0)과 guest1(원래 좌석1)이 서로 자리를 바꿈
    });
    table.addGuest('guest1', 'Guest');
    table.start();
    assert.strictEqual(table.seatByPlayer['guest1'], 0, '테스트 전제: 셔플 후 guest1이 좌석0에 있어야 함');
    assert.strictEqual(table.seatByPlayer['host1'], 1, '테스트 전제: 셔플 후 host1이 좌석1에 있어야 함');

    table.disconnect('guest1');
    // 실제로 몇 분을 기다리는 대신, "이미 오래전에 끊겼다"고 시간을 되돌려 시뮬레이션한다.
    table.humanBySeat[0].disconnectedAt = Date.now() - 10 * 60 * 1000;
    let roomClosed = false;
    table.on('roomClosed', () => { roomClosed = true; });
    const closed = table._reapLongDisconnectedHumans();
    assert.strictEqual(closed, false, '좌석0에 있는 건 게스트일 뿐이므로 방이 종료되면 안 됨');
    assert.strictEqual(roomClosed, false);
    assert.strictEqual(table.engine.seats[0], null, '오래 끊긴 게스트는 좌석에서 제거되어야 함');
    assert.strictEqual(table.status, 'in_progress', '방은 계속 진행 중이어야 함');
  });

  await check('접속 끊김 판정: 호스트가 셔플로 좌석0이 아닌 곳에 있어도 오래 끊기면 정상적으로 방이 종료됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 0,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
      rng: () => 0,
    });
    table.addGuest('guest1', 'Guest');
    table.start();
    assert.strictEqual(table.seatByPlayer['host1'], 1, '테스트 전제: 셔플 후 host1이 좌석1(0번이 아님)에 있어야 함');

    table.disconnect('host1');
    table.humanBySeat[1].disconnectedAt = Date.now() - 10 * 60 * 1000;
    let roomClosed = false;
    let closeReason = null;
    table.on('roomClosed', ({ reason }) => { roomClosed = true; closeReason = reason; });
    const closed = table._reapLongDisconnectedHumans();
    assert.strictEqual(closed, true, '호스트가 오래 끊기면 좌석 번호와 무관하게 방이 종료되어야 함');
    assert.strictEqual(roomClosed, true);
    assert.ok(closeReason.includes('호스트'), `종료 사유에 호스트가 언급되어야 함 (실제: ${closeReason})`);
  });

  await check('게임 진행: AI만 있는 경우 자동으로 여러 핸드 진행 + 칩 보존', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 4,
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0, // 여러 핸드를 빠르게 돌려야 하는 테스트라 연출용 텀을 없앰
      interHandDelayMs: 15,
      aiActionDelayMs: 0, // 여러 핸드를 빠르게 돌려야 하는 테스트라 텀을 없앰
      // 호스트(사람)가 드물게 파산해도 테스트가 방 종료 없이 끝까지 진행되도록 넉넉하게 허용
      maxRebuys: 999,
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
    // AI는 더 이상 자동으로 리바인되지 않으므로(파산하면 사람이 수동으로 결정), 칩 총량 증가는
    // 오직 호스트(사람) 본인이 파산 후 리바인을 수락한 경우에만 발생할 수 있다.
    // 어느 경우든 총량이 "감소"하는 일은 절대 없어야 하고, 오직 리바인 횟수 * 리바인액만큼만 증가해야 한다.
    assert.ok(totalAfter >= totalBefore, '칩 총량이 줄어들면 안 됨');
    const diff = totalAfter - totalBefore;
    assert.strictEqual(diff % 3000, 0, `증가분은 리바인액(3000)의 배수여야 함 (실제 diff: ${diff})`);
    table._closeRoom('test done');
  });

  await check('호스트 파산 후 리바인 거부 -> 호스트만 퇴장, 게임은 계속 진행', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 2, // 호스트가 나가도 AI 2명이 남아 게임이 계속될 수 있도록
      startingStack: 3000,
      allinRevealDelayMs: 0, // 올인 카드 순차 공개 연출은 별도 테스트에서 검증하므로 여기서는 꺼서 빠르게 돌림
      interHandDelayMs: 10,
      aiActionDelayMs: 5,
      maxRebuys: 999,
      shuffleSeatsOnStart: false, // 이 테스트는 좌석 인덱스(호스트=0)가 고정이라고 가정하므로 셔플을 끈다
    });
    table.engine.seats[0].stack = 60; // 호스트만 아주 짧은 스택으로 빠르게 파산 유도

    const stopAuto = autoDriveHumans(table, ['host1']);
    let hostLeft = false;
    let roomClosed = false;
    table.on('rebuyRequired', ({ seatIndex, playerId }) => {
      if (playerId === 'host1') table.handleRebuyDecision('host1', false); // 호스트가 리바인을 거부한다고 가정
    });
    table.on('rebuyResult', ({ seatIndex, accepted }) => {
      if (seatIndex === 0 && !accepted) hostLeft = true;
    });
    table.on('roomClosed', () => { roomClosed = true; });
    // 호스트가 초반 올인을 우연히 이겨 스택이 불어나면 파산까지 오래 걸릴 수 있으므로,
    // (아직 파산 전이라면) 매 핸드가 끝날 때마다 다시 짧은 스택으로 눌러줘서 매 핸드 올인을 강제한다.
    // AI들도 파산해서 리바인 대기로 게임이 멈추는 일이 없도록 넉넉한 스택을 유지해준다.
    table.on('handResult', () => {
      const hostSeat = table.engine.seats[0];
      if (hostSeat && hostSeat.stack > 60) hostSeat.stack = 60;
      for (const seat of table.engine.seats) {
        if (seat && seat.type === 'ai' && !seat.isSittingOut && seat.stack < 300) seat.stack = 3000;
      }
    });
    table.start();
    await wait(2000);
    stopAuto();
    assert.strictEqual(hostLeft, true, '호스트 퇴장 이벤트 발생');
    assert.strictEqual(roomClosed, false, '호스트가 파산해도 방이 종료되면 안 됨');
    assert.strictEqual(table.status, 'in_progress', '남은 AI들로 게임이 계속 진행되어야 함');
    assert.strictEqual(table.engine.seats[0], null, '호스트 좌석은 비워져야 함');
    assert.strictEqual(table.hostId, 'host1', '좌석에서 나가도 방 관리 권한(hostId)은 그대로 유지됨');
    table._closeRoom('test done');
  });

  await check('게스트 파산 후 리바인 거부 -> 게스트만 퇴장, 게임 계속', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0, // 올인 카드 순차 공개 연출은 별도 테스트에서 검증하므로 여기서는 꺼서 빠르게 돌림
      interHandDelayMs: 15,
      aiActionDelayMs: 5,
      // "명시적으로 거부"하는 경로를 검증하려는 테스트이므로, maxRebuys=0(리바인 자체가 불가능)
      // 때문에 리바인 요청이 아예 뜨지 않는 경로로 새지 않도록 넉넉하게 허용해준다.
      maxRebuys: 999,
      shuffleSeatsOnStart: false, // 좌석 인덱스(게스트=1)가 고정이라고 가정하는 테스트라 셔플을 끈다
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
      // 이 테스트의 rebuyRequired 핸들러는 게스트만 처리하므로, 호스트가 우연히 파산하면
      // 응답 없는 리바인 요청 때문에 진행이 멈출 수 있다 -> 호스트 스택을 넉넉하게 유지.
      const hostSeat = table.engine.seats[0];
      if (hostSeat && hostSeat.stack < 300) hostSeat.stack = 3000;
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
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0, // 올인 카드 순차 공개 연출은 별도 테스트에서 검증하므로 여기서는 꺼서 빠르게 돌림
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 1,
      rebuyAmount: 55, // 리바인해도 다시 짧은 스택이라 금방 재파산하도록 함
      shuffleSeatsOnStart: false, // 좌석 인덱스(게스트=1)가 고정이라고 가정하는 테스트라 셔플을 끈다
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
      // 이 테스트는 "게스트의" maxRebuys 초과 처리를 검증하려는 것인데, maxRebuys는 호스트에게도
      // 똑같이 적용되므로 호스트가 우연히 파산해서 응답 없는 리바인 요청으로 진행이 멈춰버리는
      // 일이 없도록 호스트 스택을 넉넉하게 유지해준다.
      const hostSeat = table.engine.seats[0];
      if (hostSeat && hostSeat.stack < 300) hostSeat.stack = 3000;
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
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      addOnAmount: 500,
      shuffleSeatsOnStart: false, // 좌석 인덱스(호스트=0)가 고정이라고 가정하는 테스트라 셔플을 끈다
    });
    table.start();
    const before = table.engine.seats[0].stack;
    table.useAddOn('host1');
    assert.strictEqual(table.engine.seats[0].stack, before + 500);
    assert.throws(() => table.useAddOn('host1'), /이미 애드온/);
    table._closeRoom('test done');
  });

  await check('로비에서 호스트가 설정 변경 가능 (AI 인원수, 블라인드 구조, BB 앤티 등)', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 2, startingStack: 3000 });
    assert.strictEqual(table.config.bbAnte, true, '기본값은 BB 앤티 사용');
    assert.strictEqual(table.blinds.levels[0].ante, table.blinds.levels[0].bb, '기본 상태에서는 앤티=bb여야 함');
    table.updateConfig('host1', {
      aiCount: 4,
      blindLevels: [
        { sb: 100, bb: 200, ante: 0, durationMinutes: 10 },
        { sb: 200, bb: 400, ante: 0, durationMinutes: 10 },
      ],
      bbAnte: false,
      aiActionDelayMs: 1234,
    });
    const lobby = table.getLobbyState();
    const aiSeated = lobby.seats.filter((s) => s && s.type === 'ai').length;
    assert.strictEqual(aiSeated, 4);
    assert.strictEqual(table.blinds.levels[0].sb, 100);
    assert.strictEqual(table.blinds.levels[0].bb, 200);
    assert.strictEqual(table.config.bbAnte, false);
    assert.strictEqual(table.blinds.levels[0].ante, 0, 'BB 앤티를 끄면 앤티가 0이어야 함');
    assert.strictEqual(table.config.aiActionDelayMs, 1234);
    assert.throws(() => table.updateConfig('guest-imposter', { aiCount: 1 }), /호스트만/);
  });

  await check('블라인드 구조(레벨 추가/삭제/개별 시간·금액)를 로비에서 통째로 교체 가능', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 1, startingStack: 3000 });
    table.updateConfig('host1', {
      blindLevels: [
        { sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
        { sb: 200, bb: 400, ante: 0, durationMinutes: 10 },
        { sb: 300, bb: 600, ante: 0, durationMinutes: 3 },
      ],
    });
    assert.strictEqual(table.blinds.levels.length, 3, '레벨 개수가 새 구조로 교체되어야 함');
    table.blinds.start(1_000_000);
    assert.strictEqual(table.blinds.currentLevelIndex(1_000_000 + 6 * 60000), 0, '6분: 아직 레벨1(7분)');
    assert.strictEqual(table.blinds.currentLevelIndex(1_000_000 + 7 * 60000), 1, '7분: 레벨2로 승급');
  });

  await check('휴식(브레이크) 레벨을 포함한 구조도 그대로 반영되고, 직전 레벨 블라인드를 이어받음', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 1, startingStack: 3000 });
    table.updateConfig('host1', {
      blindLevels: [
        { sb: 100, bb: 200, ante: 50, durationMinutes: 5 },
        { isBreak: true, durationMinutes: 5 },
        { sb: 300, bb: 600, ante: 0, durationMinutes: 5 },
      ],
    });
    assert.strictEqual(table.blinds.levels[1].isBreak, true);
    table.blinds.start(1_000_000);
    const duringBreak = table.blinds.getCurrent(1_000_000 + 7 * 60000);
    assert.strictEqual(duringBreak.isBreak, true);
    assert.strictEqual(duringBreak.sb, 100, '휴식 중에도 실제 적용 블라인드는 직전 레벨 값을 유지해야 함');
    assert.strictEqual(duringBreak.ante, 50);
  });

  await check('"BB 앤티 사용유무" 일괄 토글은 레벨별 sb/bb/시간은 그대로 두고 앤티만 일괄 변경함', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 1,
      startingStack: 3000,
      bbAnte: false,
      blindLevels: [
        { sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
        { isBreak: true, durationMinutes: 5 },
        { sb: 200, bb: 400, ante: 0, durationMinutes: 7 },
      ],
    });
    table.updateConfig('host1', { bbAnte: true });
    assert.strictEqual(table.blinds.levels[0].ante, 200, '실제 레벨은 앤티=bb로 켜져야 함');
    assert.strictEqual(table.blinds.levels[0].sb, 100, '앤티 토글이 sb/bb/시간을 건드리면 안 됨');
    assert.strictEqual(table.blinds.levels[1].isBreak, true, '휴식 레벨은 토글 후에도 그대로 유지되어야 함');
    assert.strictEqual(table.blinds.levels[2].ante, 400);
  });

  await check('블라인드 구조 편집은 로비에서만 가능하고, 게임 진행 중에는 변경되지 않음', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 1,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
    });
    table.start();
    const before = table.blinds.levels;
    table.updateConfig('host1', {
      blindLevels: [{ sb: 999, bb: 1998, ante: 0, durationMinutes: 7 }],
    });
    assert.strictEqual(table.blinds.levels, before, '진행 중에는 blindLevels가 화이트리스트에 없으므로 변경되면 안 됨');
    table._closeRoom('test done');
  });

  await check('게임 진행 중에는 aiCount/startingStack 같은 항목은 변경되지 않음(화이트리스트)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 2,
      startingStack: 3000,
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

  await check('AI 실력(aiSkillLevel) 설정 값이 적용되고 0~100 범위로 clamp됨', async () => {
    const table = new TableManager({ hostId: 'host1', aiCount: 1, startingStack: 3000 });
    assert.strictEqual(table.config.aiSkillLevel, 75, '기본값은 75여야 함');
    table.updateConfig('host1', { aiSkillLevel: 30 });
    assert.strictEqual(table.config.aiSkillLevel, 30);
    table.updateConfig('host1', { aiSkillLevel: 999 });
    assert.strictEqual(table.config.aiSkillLevel, 100, '100을 넘는 값은 100으로 clamp되어야 함');
    table.updateConfig('host1', { aiSkillLevel: -20 });
    assert.strictEqual(table.config.aiSkillLevel, 0, '0 미만 값은 0으로 clamp되어야 함');
  });

  await check('재접속 시 놓친 handResult/awaitNextHand를 다시 받을 수 있음(getReconnectExtras)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 999,
    });
    let awaitFired = false;
    table.on('awaitNextHand', () => { awaitFired = true; });
    const forceHostActive = () => {
      const st = table.engine;
      if (st.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = st.seats[st.actingSeat];
      if (!seat || seat.playerId !== 'host1') return;
      const legal = st.getLegalActions(st.actingSeat);
      if (!legal) return;
      const action = legal.canCheck ? 'check' : legal.canCall ? 'call' : 'allin';
      try { table.handleAction('host1', action, 0); } catch (e) { /* 무시 */ }
    };
    table.on('state', forceHostActive);
    table.start();
    await wait(400);

    const extras = table.getReconnectExtras('host1');
    assert.ok(extras, 'getReconnectExtras는 null이 아니어야 함');
    assert.ok(extras.handResult, '재접속 시 마지막 핸드 결과를 다시 보내줘야 함');
    if (awaitFired) {
      assert.ok(extras.awaitNextHand, '아직 준비를 누르지 않았다면 다음 핸드 대기 정보도 다시 보내줘야 함');
      table.handleReadyForNextHand('host1');
      const extras2 = table.getReconnectExtras('host1');
      assert.ok(!extras2.awaitNextHand, '이미 준비를 누른 사람에게는 다시 대기 화면을 보여줄 필요 없음');
    }
    table._closeRoom('test done');
  });

  await check('AI 액션이 playerAction 이벤트로 전달됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 3,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      // 이 테스트는 호스트(사람)가 자동으로 액션하지 않으므로, 좌석이 섞여 호스트가 첫
      // 액션자(UTG)로 배치되면 AI 액션이 하나도 나오지 않은 채 호스트 차례에서 멈춰버릴 수
      // 있다. 이 테스트는 순전히 "AI 액션이 이벤트로 전달되는지"만 보려는 것이므로 셔플을 끈다.
      shuffleSeatsOnStart: false,
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
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      // 이 테스트는 "결과 확인 대기" 흐름만 검증하려는 것이므로, 상대가 1명뿐인 상황에서
      // 그 AI가 우연히 파산해 방이 종료되어 버리는 일이 없도록 리바인을 넉넉히 허용한다.
      maxRebuys: 999,
    });
    let awaitCount = 0;
    let handEnded = false;
    table.on('awaitNextHand', () => { awaitCount++; });
    table.on('handResult', (result) => {
      handEnded = true;
      assert.strictEqual(typeof result.requiresConfirm, 'boolean', 'handResult에 requiresConfirm 플래그가 있어야 함');
    });
    // 이 테스트는 "결과 확인 대기" 흐름만 검증하려는 것이므로, 상대 AI가 어쩌다 파산해서
    // 사람의 수동 리바인 결정을 기다리며 게임이 멈춰버리는 일이 없도록 즉시 리바인시켜준다.
    table.on('waitingForAiRebuy', ({ seats }) => {
      for (const s of seats) {
        try { table.handleAiRebuyDecision('host1', s, true); } catch (e) { /* 무시 */ }
      }
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
      await wait(600);
      assert.ok(table.engine.handNumber > handNumberBefore, '모두 준비 완료하면 다음 핸드로 진행되어야 함');
    }
    table._closeRoom('test done');
  });

  await check('사람이 일찍 폴드해도 자기 핸드에 참여했다면 결과 확인 대기 후 진행', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      // 상대가 1명뿐인 상황에서 그 AI가 우연히 파산해 방이 종료되는 일이 없도록 넉넉히 허용
      maxRebuys: 999,
    });
    let awaitCount = 0;
    let sawRequiresConfirmTrue = false;
    table.on('awaitNextHand', () => { awaitCount++; });
    table.on('handResult', (result) => {
      if (result.requiresConfirm) sawRequiresConfirmTrue = true;
    });
    // 이 테스트는 "일찍 폴드해도 결과 확인 대기" 흐름만 검증하려는 것이므로, 상대 AI가 어쩌다
    // 파산해서 사람의 수동 리바인 결정을 기다리며 게임이 멈춰버리는 일이 없도록 즉시 리바인시켜준다.
    table.on('waitingForAiRebuy', ({ seats }) => {
      for (const s of seats) {
        try { table.handleAiRebuyDecision('host1', s, true); } catch (e) { /* 무시 */ }
      }
    });
    // 호스트는 자기 차례가 오면 항상 폴드(가능한 경우)한다.
    const forceHostFold = () => {
      const st = table.engine;
      if (st.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = st.seats[st.actingSeat];
      if (!seat || seat.playerId !== 'host1') return;
      const legal = st.getLegalActions(st.actingSeat);
      if (!legal) return;
      const action = legal.canFold ? 'fold' : legal.canCheck ? 'check' : 'call';
      try {
        table.handleAction('host1', action, 0);
      } catch (e) {
        // 무시
      }
    };
    table.on('state', forceHostFold);
    table.start();
    await wait(400);
    assert.strictEqual(sawRequiresConfirmTrue, true, '일찍 폴드했어도 이번 핸드에 참여했다면 requiresConfirm이 true여야 함');
    const handNumberBefore = table.engine.handNumber;
    await wait(500);
    assert.ok(awaitCount > 0, '폴드했어도 다음 핸드 준비 확인(awaitNextHand)을 기다려야 함');
    assert.strictEqual(table.engine.handNumber, handNumberBefore, '준비 확인 전에는 다음 핸드로 넘어가면 안 됨');
    table.handleReadyForNextHand('host1');
    await wait(600);
    assert.ok(table.engine.handNumber > handNumberBefore, '준비 완료하면 다음 핸드로 진행되어야 함');
    table._closeRoom('test done');
  });

  await check('다음 핸드 진행은 게스트 동의 없이 호스트만 눌러도 됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 0,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 999,
      shuffleSeatsOnStart: false,
    });
    table.addGuest('guest1', 'Guest');
    let awaitCount = 0;
    table.on('awaitNextHand', () => { awaitCount++; });
    // 두 사람 모두 체크/콜만 하도록(폴드 없이) 진행시켜 매 핸드 결과 확인 대기가 걸리게 한다.
    const autoCall = () => {
      const st = table.engine;
      if (st.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = st.seats[st.actingSeat];
      if (!seat || seat.type !== 'human') return;
      const legal = st.getLegalActions(st.actingSeat);
      if (!legal) return;
      const action = legal.canCheck ? 'check' : legal.canCall ? 'call' : 'allin';
      try { table.handleAction(seat.playerId, action, 0); } catch (e) { /* 무시 */ }
    };
    table.on('state', autoCall);
    table.start();
    await wait(400);
    const handNumberBefore = table.engine.handNumber;
    assert.ok(awaitCount > 0, '두 사람 다 살아있으면 결과 확인 대기를 걸어야 함');

    // 게스트 혼자 "준비"를 눌러도 호스트가 안 눌렀으면 다음 핸드로 넘어가면 안 된다.
    table.handleReadyForNextHand('guest1');
    await wait(300);
    assert.strictEqual(table.engine.handNumber, handNumberBefore, '게스트 혼자만의 준비로는 다음 핸드로 넘어가면 안 됨');

    // 호스트가 누르면(게스트 동의와 무관하게) 바로 다음 핸드로 진행되어야 한다.
    table.handleReadyForNextHand('host1');
    await wait(400);
    assert.ok(table.engine.handNumber > handNumberBefore, '호스트가 누르면 게스트 동의 없이 다음 핸드로 진행되어야 함');
    table._closeRoom('test done');
  });

  await check('AI 파산 시 자동으로 리바인되지 않고, 사람이 좌석을 클릭해 직접 결정해야 함', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0, // 올인 카드 순차 공개 연출은 별도 테스트에서 검증하므로 여기서는 꺼서 빠르게 돌림
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 1,
      rebuyAmount: 55,
      shuffleSeatsOnStart: false, // 좌석 인덱스(AI=maxSeats-1)가 고정이라고 가정하는 테스트라 셔플을 끈다
    });
    // AI는 이제 맨 뒷자리(좌석 maxSeats-1)부터 채워진다 (낮은 인덱스는 사람 합류용으로 비워둠)
    const aiSeatIndex = table.maxSeats - 1;
    table.engine.seats[aiSeatIndex].stack = 55; // AI를 짧은 스택으로 빠르게 파산시킴
    const stopAuto = autoDriveHumans(table, ['host1']);
    table.on('awaitNextHand', () => table.handleReadyForNextHand('host1'));
    // AI가 다시 칩을 불려서 파산까지 오래 걸리는 일이 없도록 매 핸드 끝에 짧은 스택으로 눌러준다.
    table.on('handResult', () => {
      const s = table.engine.seats[aiSeatIndex];
      if (s && !s.isSittingOut && s.stack > 55) s.stack = 55;
    });
    table.start();
    await wait(1500);
    stopAuto();

    const aiSeat = table.engine.seats[aiSeatIndex];
    assert.ok(aiSeat, 'AI 좌석은 제거되지 않고 그대로 남아있어야 함(사람 좌석과 달리 자동 탈락되지 않음)');
    assert.strictEqual(aiSeat.stack, 0, '파산한 AI는 자동으로 리바인되지 않고 스택 0이어야 함');
    assert.strictEqual(aiSeat.isSittingOut, true, '파산한 AI는 자동으로 비활성화(sitting-out) 상태가 되어야 함');
    assert.strictEqual(table.rebuyCounts[aiSeatIndex] || 0, 0, '사람이 결정하기 전까지는 리바인 횟수가 늘어나면 안 됨');
    assert.strictEqual(table.status, 'in_progress', '더 이상 핸드를 시작할 수 없어도 방이 닫히지 않고 대기해야 함');

    // 사람이 직접 리바인을 수락하면 정상적으로 리바인됨. 방이 다음 핸드를 시작할 수 없어
    // 대기 중이었다면 리바인 즉시 다음 핸드가 재개될 수 있으므로(블라인드가 곧바로 깎일 수
    // 있으므로), 실제로 지급된 금액은 seat의 "현재" 스택이 아니라 반환값으로 확인한다.
    const accepted = table.handleAiRebuyDecision('host1', aiSeatIndex, true);
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.stack, 55, '리바인으로 지급된 칩은 rebuyAmount(55)여야 함');
    assert.strictEqual(table.engine.seats[aiSeatIndex].isSittingOut, false);
    assert.strictEqual(table.rebuyCounts[aiSeatIndex], 1);

    // maxRebuys(1)를 이미 다 썼으므로, 다시 파산하면 더 이상 리바인할 수 없어야 함
    table.engine.seats[aiSeatIndex].stack = 0;
    table.engine.seats[aiSeatIndex].isSittingOut = true;
    assert.throws(() => table.handleAiRebuyDecision('host1', aiSeatIndex, true), /리바인/);

    // 거부(accept:false)는 상태를 바꾸지 않아야 함
    const declined = table.handleAiRebuyDecision('host1', aiSeatIndex, false);
    assert.strictEqual(declined.accepted, false);
    assert.strictEqual(table.engine.seats[aiSeatIndex].stack, 0, '거부하면 스택이 그대로 0이어야 함');

    table._closeRoom('test done');
  });

  await check('handleAiRemoveDecision: 리바인 여지가 남은 AI도 "리바인 안하고 내보내기"로 좌석에서 완전히 제거 가능', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1, // 상대가 AI 1명뿐 -> 제거하면 인원 부족으로 방이 종료되어야 함
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 999, // 리바인 여지가 충분히 남아있는 상태에서도 내보낼 수 있어야 함을 보이기 위함
      shuffleSeatsOnStart: false,
    });
    const aiSeatIndex = table.maxSeats - 1;
    table.engine.seats[aiSeatIndex].stack = 55;
    const stopAuto = autoDriveHumans(table, ['host1']);
    table.on('handResult', () => {
      const s = table.engine.seats[aiSeatIndex];
      if (s && !s.isSittingOut && s.stack > 55) s.stack = 55;
    });
    table.start();
    await wait(1500);
    stopAuto();

    const aiSeat = table.engine.seats[aiSeatIndex];
    assert.ok(aiSeat && aiSeat.isSittingOut && aiSeat.stack === 0, '테스트 전제: AI가 파산해 대기 중이어야 함');
    assert.ok((table.rebuyCounts[aiSeatIndex] || 0) < table.config.maxRebuys, '테스트 전제: 아직 리바인 여지가 남아있어야 함');

    // "닫기"(그냥 무시)와 달리, 이건 확정적으로 좌석을 비운다.
    let removeReason = null;
    table.on('rebuyResult', ({ seatIndex, accepted, reason }) => {
      if (seatIndex === aiSeatIndex && !accepted) removeReason = reason;
    });
    let roomClosed = false;
    table.on('roomClosed', () => { roomClosed = true; });
    const result = table.handleAiRemoveDecision('host1', aiSeatIndex);
    assert.strictEqual(result.removed, true);
    assert.strictEqual(removeReason, 'removedByHost');
    assert.strictEqual(table.engine.seats[aiSeatIndex], null, 'AI 좌석은 완전히 비워져야 함');
    assert.strictEqual(table.rebuyCounts[aiSeatIndex], undefined, '리바인 횟수 기록도 함께 정리되어야 함');
    // 상대가 그 AI 1명뿐이었으므로, 제거 후 인원 부족으로 방이 종료되는 것이 정상 동작
    assert.strictEqual(roomClosed, true, '남은 참가자가 1명뿐이면 방이 종료되어야 함');
  });

  await check('handleAiRemoveDecision: 스택이 남아있거나 AI가 아닌 좌석은 내보낼 수 없음', async () => {
    const table = new TableManager({
      hostId: 'host1',
      aiCount: 1,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 60000, // 검증 도중 AI가 먼저 액션해버리지 않도록 텀을 크게 둠
      shuffleSeatsOnStart: false,
    });
    table.start();
    const aiSeatIndex = table.maxSeats - 1;
    assert.throws(() => table.handleAiRemoveDecision('host1', aiSeatIndex), /내보낼 수 있는 상태가 아닙니다/, '스택이 남아있는 AI는 내보낼 수 없어야 함');
    assert.throws(() => table.handleAiRemoveDecision('host1', 0), /AI 좌석이 아닙니다/, '사람 좌석(호스트)은 내보낼 수 없어야 함');
    table._closeRoom('test done');
  });

  await check('maxRebuys=0이면 파산 시 리바인 요청 없이 즉시 탈락 처리됨(리바인 무제한 개념 제거)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      blindLevels: [{ sb: 25, bb: 50, ante: 0, durationMinutes: 5 }],
      allinRevealDelayMs: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 0,
      rebuyAmount: 3000,
      shuffleSeatsOnStart: false, // 좌석 인덱스(게스트=1, 호스트=0)가 고정이라고 가정하는 테스트라 셔플을 끈다
    });
    table.addGuest('guest1', 'Guest');
    table.engine.seats[1].stack = 55; // 게스트를 빠르게 파산시킴

    const stopAuto = autoDriveHumans(table, ['host1', 'guest1']);
    let rebuyRequiredFired = false;
    let guestLeftReason = null;
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'guest1') rebuyRequiredFired = true;
    });
    table.on('rebuyResult', ({ seatIndex, accepted, reason }) => {
      if (seatIndex === 1 && !accepted) guestLeftReason = reason;
    });
    table.on('handResult', () => {
      const guestSeat = table.engine.seats[1];
      if (guestSeat && guestSeat.stack > 55) guestSeat.stack = 55;
      // 이 테스트가 검증하려는 건 "게스트의" maxRebuys=0 동작이므로, 호스트/AI가 우연히
      // 파산해서(둘 다 maxRebuys=0 적용을 받아 방 종료/일시정지로 새 버리는 일이 없도록)
      // 넉넉한 스택으로 유지해준다.
      const hostSeat = table.engine.seats[0];
      if (hostSeat && hostSeat.stack < 300) hostSeat.stack = 3000;
      const aiSeat = table.engine.seats[table.maxSeats - 1];
      if (aiSeat && !aiSeat.isSittingOut && aiSeat.stack < 300) aiSeat.stack = 3000;
    });
    table.start();
    await wait(2000);
    stopAuto();

    assert.strictEqual(rebuyRequiredFired, false, 'maxRebuys=0이면 리바인 요청 자체가 뜨면 안 됨');
    assert.strictEqual(guestLeftReason, 'maxRebuysReached', '리바인이 불가능하므로 즉시 탈락 처리되어야 함');
    assert.strictEqual(table.engine.seats[1], null, '게스트 좌석은 비워져야 함');
    assert.strictEqual(table.status, 'in_progress', '게스트만 탈락하고 게임은 계속되어야 함');
    table._closeRoom('test done');
  });

  await check('AI도 리바인 한도를 다 쓰면(또는 maxRebuys=0) 사람 응답을 기다리지 않고 좌석에서 제거됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1, // 상대가 AI 1명뿐 -> 이 AI가 완전히 제거되면 인원 부족으로 방이 종료됨
      startingStack: 3000,
      allinRevealDelayMs: 0,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 0, // AI도 예외 없이 리바인 불가
      shuffleSeatsOnStart: false, // 좌석 인덱스(AI=maxSeats-1)가 고정이라고 가정하는 테스트라 셔플을 끈다
    });
    const aiSeatIndex = table.maxSeats - 1;
    table.engine.seats[aiSeatIndex].stack = 55; // AI를 빠르게 파산시킴

    const stopAuto = autoDriveHumans(table, ['host1']);
    let waitingForAiRebuyFired = false;
    let aiRebuyResultReason = null;
    let roomClosed = false;
    let roomClosedReason = null;
    table.on('waitingForAiRebuy', () => { waitingForAiRebuyFired = true; });
    table.on('rebuyResult', ({ seatIndex, accepted, reason }) => {
      if (seatIndex === aiSeatIndex && !accepted) aiRebuyResultReason = reason;
    });
    table.on('roomClosed', ({ reason }) => { roomClosed = true; roomClosedReason = reason; });
    // AI가 초반 올인을 우연히 이겨 스택이 불어나면 파산까지 오래 걸려 테스트가 느려지거나(드물게)
    // 시간 안에 파산하지 않을 수 있으므로, 매 핸드가 끝날 때마다 다시 짧은 스택으로 눌러줘서
    // 매 핸드 올인을 강제한다(이미 파산해 좌석이 제거된 뒤라면 seat가 null이라 자연히 무시됨).
    table.on('handResult', () => {
      const aiSeat = table.engine.seats[aiSeatIndex];
      if (aiSeat && aiSeat.stack > 55) aiSeat.stack = 55;
    });
    table.start();
    await wait(3000);
    stopAuto();

    // 리바인이 애초에 불가능한(maxRebuys=0) AI이므로, 사람에게 리바인 여부를 묻는(수동 확인 대기)
    // 일 없이 곧바로 탈락 처리되어야 한다.
    assert.strictEqual(waitingForAiRebuyFired, false, 'AI가 리바인 불가능하면 확인 대기 없이 바로 제거되어야 함');
    assert.strictEqual(aiRebuyResultReason, 'maxRebuysReached', 'AI 제거 사유는 maxRebuysReached여야 함');
    assert.strictEqual(table.engine.seats[aiSeatIndex], null, 'AI 좌석은 완전히 비워져야 함');
    // 상대가 AI 1명뿐이었으므로, 제거 후에는 인원 부족으로 방이 종료되는 것이 정상 동작이다.
    assert.strictEqual(roomClosed, true, '남은 참가자가 1명뿐이면 방이 종료되어야 함');
    assert.ok(roomClosedReason.includes('참가자'), `종료 사유가 인원 부족이어야 함 (실제: ${roomClosedReason})`);
  });

  await check('올인 쇼다운에서는 보드 카드가 한 번에 다 공개되지 않고 한 장씩 순서대로 공개된다', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 60,
      rebuyAmount: 60,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      maxRebuys: 999,
      shuffleSeatsOnStart: false, // 좌석 인덱스(AI=maxSeats-1)가 고정이라고 가정하는 테스트라 셔플을 끈다
    });
    // 호스트만 짧은 스택으로 매 핸드 올인시키고, AI는 넉넉한 스택을 유지시켜 콜을 받아준다
    // (AI까지 매번 파산하면 사람의 수동 리바인 결정을 기다리며 게임이 멈춰버려 이 테스트가
    // 검증하려는 "올인 쇼다운 단계적 공개"까지 도달하지 못할 수 있다).
    const aiSeatIndex = table.maxSeats - 1;
    table.engine.seats[aiSeatIndex].stack = 5000;

    // 핸드별로 boardReveal에서 관찰한 보드 길이들을 모아둔다
    let currentRevealLens = [];
    const revealSequences = [];
    table.on('boardReveal', ({ board }) => currentRevealLens.push(board.length));
    table.on('handResult', () => {
      if (currentRevealLens.length) revealSequences.push(currentRevealLens.slice());
      currentRevealLens = [];
      const aiSeat = table.engine.seats[aiSeatIndex];
      if (aiSeat && !aiSeat.isSittingOut && aiSeat.stack < 1000) aiSeat.stack = 5000;
    });

    // 호스트는 자기 차례가 오면 항상 올인으로 밀어붙여서 올인 쇼다운이 자주 나오게 한다
    const forceHostAllIn = () => {
      if (table.status !== 'in_progress' || table.engine.actingSeat === -1) return;
      const seat = table.engine.seats[table.engine.actingSeat];
      if (!seat || seat.playerId !== 'host1') return;
      try {
        table.handleAction('host1', 'allin', 0);
      } catch (e) {
        // 무시
      }
    };
    table.on('state', forceHostAllIn);
    table.on('rebuyRequired', ({ playerId }) => {
      if (playerId === 'host1') table.handleRebuyDecision('host1', true);
    });
    table.on('awaitNextHand', () => table.handleReadyForNextHand('host1'));

    table.start();
    await wait(8000);
    table._closeRoom('test done');

    assert.ok(revealSequences.length > 0, '최소 한 핸드는 올인 쇼다운에서 카드가 단계적으로 공개되어야 함');
    for (const lens of revealSequences) {
      for (let i = 1; i < lens.length; i++) {
        assert.strictEqual(lens[i], lens[i - 1] + 1, `보드 카드는 한 번에 한 장씩만 공개되어야 함 (관찰된 길이: ${lens.join(',')})`);
      }
    }
  });

  await check('사람 전용 베팅 제한시간(actionTimeLimitSec): 시간 초과 시 자동으로 체크/폴드 처리됨', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      actionTimeLimitSec: 1, // 짧게 잡아서 테스트가 오래 걸리지 않게 함
      maxRebuys: 999,
      shuffleSeatsOnStart: false,
    });
    let clockEvents = 0;
    let lastClockPayload = null;
    table.on('actionClock', (info) => {
      clockEvents++;
      lastClockPayload = info;
    });
    table.on('waitingForAiRebuy', ({ seats }) => {
      for (const s of seats) { try { table.handleAiRebuyDecision('host1', s, true); } catch (e) { /* 무시 */ } }
    });
    table.on('awaitNextHand', () => table.handleReadyForNextHand('host1'));

    // 호스트는 일부러 아무 액션도 하지 않는다 - 제한시간이 지나면 서버가 알아서
    // 체크(가능하면) 또는 폴드로 자동 처리해줘야 게임이 멈추지 않는다.
    table.start();
    await wait(2500);
    table._closeRoom('test done');

    assert.ok(clockEvents > 0, '사람 차례가 되면 actionClock 이벤트가 발생해야 함');
    assert.strictEqual(lastClockPayload.limitSec, 1, 'actionClock 페이로드에 설정한 제한시간이 그대로 담겨야 함');
    assert.ok(typeof lastClockPayload.deadline === 'number' && lastClockPayload.deadline > Date.now() - 3000);
    // 호스트가 한 번도 직접 액션하지 않았는데도, 자동 체크/폴드 덕분에 핸드가 진행되어 최소
    // 한 번은 다음 핸드로 넘어갔어야 한다(그렇지 않으면 게임이 첫 핸드에서 멈춰있게 됨).
    assert.ok(table.engine.handNumber >= 2, `자동 처리로 핸드가 계속 진행되어야 함 (실제 handNumber: ${table.engine.handNumber})`);
  });

  await check('사람 전용 베팅 제한시간은 AI 차례에는 적용되지 않음(actionClock이 AI 좌석으로는 발생하지 않음)', async () => {
    const table = new TableManager({
      hostId: 'host1',
      hostName: 'Host',
      aiCount: 1,
      startingStack: 3000,
      interHandDelayMs: 10,
      aiActionDelayMs: 0,
      actionTimeLimitSec: 1,
      maxRebuys: 999,
      shuffleSeatsOnStart: false,
    });
    const clockSeats = new Set();
    table.on('actionClock', ({ seatIndex }) => clockSeats.add(seatIndex));
    table.on('waitingForAiRebuy', ({ seats }) => {
      for (const s of seats) { try { table.handleAiRebuyDecision('host1', s, true); } catch (e) { /* 무시 */ } }
    });
    table.on('awaitNextHand', () => table.handleReadyForNextHand('host1'));

    // 호스트는 일부러 아무 액션도 하지 않는다 - 제한시간 초과로 자동 처리되면서 게임이
    // 진행되는 동안, AI 차례에는 actionClock이 걸리지 않는지 확인한다.
    const aiSeatIndex = table.engine.seats.findIndex((s) => s && s.type === 'ai');
    const humanSeatIndex = table.engine.seats.findIndex((s) => s && s.type === 'human');
    table.start();
    await wait(2500);
    table._closeRoom('test done');

    assert.ok(clockSeats.has(humanSeatIndex), '사람(호스트) 좌석에는 actionClock이 걸려야 함');
    assert.ok(!clockSeats.has(aiSeatIndex), 'AI 좌석에는 actionClock이 걸리면 안 됨');
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
