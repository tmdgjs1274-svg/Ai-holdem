'use strict';

const assert = require('assert');
const { TableManager } = require('../src/session/TableManager');
const { decideAction } = require('../src/ai/AIDecisionEngine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function drive(table, ids) {
  const act = () => {
    const e = table.engine;
    if (e.actingSeat === -1 || table.status !== 'in_progress') return;
    const seat = e.seats[e.actingSeat];
    if (!seat || seat.type !== 'human' || !ids.includes(seat.playerId)) return;
    const d = decideAction(e, e.actingSeat, { skillLevel: 75 });
    try { table.handleAction(seat.playerId, d.actionType, d.amount || 0); } catch (err) { /* 경합 무시 */ }
  };
  const ready = () => {
    for (const id of ids) { try { table.handleReadyForNextHand(id); } catch (err) { /* 무시 */ } }
  };
  table.on('state', act);
  table.on('awaitNextHand', ready);
  // 칩이 바닥난 사람은 자동으로 리바인해서 계속 진행시킨다(안 하면 리바인 결정 대기로 멈춤).
  table.on('rebuyRequired', ({ playerId }) => {
    if (ids.includes(playerId)) { try { table.handleRebuyDecision(playerId, true); } catch (err) { /* 무시 */ } }
  });
  table.on('waitingForAiRebuy', ({ seats }) => {
    for (const s of seats) { try { table.handleAiRebuyDecision('host1', s, true); } catch (err) { /* 무시 */ } }
  });
}

function makeTable(extra = {}) {
  const table = new TableManager({
    hostId: 'host1', hostName: '호스트', aiCount: 3, startingStack: 20000,
    interHandDelayMs: 10, aiActionDelayMs: 0, allinRevealDelayMs: 0,
    maxRebuys: 999, shuffleSeatsOnStart: false, ...extra,
  });
  table.addGuest('guest1', '게스트');
  drive(table, ['host1', 'guest1']);
  return table;
}

async function collect(table, minHands, maxMs) {
  const views = [];
  table.on('handResult', () => {
    views.push({
      host: table.getHandResultFor('host1'),
      guest: table.getHandResultFor('guest1'),
      raw: table._lastHandResult,
      review: table._lastHandReview,
    });
  });
  table.start();
  const t0 = Date.now();
  while (views.length < minHands && Date.now() - t0 < maxMs) await wait(50);
  table._closeRoom('test done');
  return views;
}

async function run() {
  let n = 0;
  const check = async (label, fn) => { await fn(); n++; console.log(`  ok - ${label}`); };

  await check('decideAction: 프리플랍/포스트플랍 모든 결정에 reason이 붙어 있음', async () => {
    const table = makeTable();
    let decisions = 0;
    let missing = 0;
    const streets = new Set();
    table.on('playerAction', () => {});
    // AI 결정이 실제로 기록되는지를 리뷰 로그로 확인한다.
    const views = await collect(table, 30, 20000);
    assert.ok(views.length >= 10, `충분한 핸드가 진행되어야 함(실제 ${views.length})`);
    for (const v of views) {
      for (const p of v.review.players) {
        for (const a of p.actions) {
          decisions++;
          streets.add(a.street);
          if (!a.reason || a.reason === '(이유 정보 없음)') missing++;
        }
      }
    }
    assert.ok(decisions > 20, 'AI 액션이 충분히 기록되어야 함');
    assert.strictEqual(missing, 0, `reason이 없는 AI 액션 ${missing}건`);
    assert.ok(streets.has('preflop'), '프리플랍 액션이 기록되어야 함');
    assert.ok(streets.has('flop') || streets.has('turn') || streets.has('river'), '포스트플랍 액션도 기록되어야 함');
  });

  await check('리뷰 문장은 일반인이 읽을 수 있는 쉬운 말: 전문용어/내부 변수 없음, 숫자 설명은 detail로 분리', async () => {
    const table = makeTable({ aiSkillLevel: 100 });
    const views = await collect(table, 40, 25000);
    const JARGON = /이퀴티|팟오즈|MDF|GTO|폴라라이즈|밸류벳|블러프캐치|브러프캐치|3벳|4벳|오픈 기준|셔브|감쇠|점수 \d|×\d/;
    let checked = 0;
    let withDetail = 0;
    let withSituation = 0;
    for (const v of views) {
      for (const p of v.review.players) {
        for (const a of p.actions) {
          checked++;
          assert.ok(!JARGON.test(a.reason), `쉬운 설명에 전문용어가 섞임: ${a.reason}`);
          assert.ok(a.reason.length >= 10, '설명이 너무 짧음');
          if (a.detail) withDetail++;
          if (a.situation) withSituation++;
        }
      }
    }
    assert.ok(checked > 30);
    assert.strictEqual(withDetail, checked, '모든 액션에 숫자 설명(detail)이 있어야 함');
    assert.strictEqual(withSituation, checked, '모든 액션에 상황 요약(situation)이 있어야 함');
  });

  await check('호스트는 전원(폴드한 AI 홀카드 포함), 게스트는 쇼다운 도달 AI만 - 폴드 AI 카드 유출 없음', async () => {
    const table = makeTable();
    const views = await collect(table, 40, 25000);
    let sawFoldedForHost = false;
    let sawShowdownForGuest = false;
    for (const v of views) {
      assert.ok(v.host.aiReview && v.host.aiReview.scope === 'all', '호스트는 scope=all');
      assert.ok(v.guest.aiReview && v.guest.aiReview.scope === 'showdown', '게스트는 scope=showdown');
      const shown = new Set((v.raw.showdown || []).map((p) => p.seatIndex));
      for (const p of v.guest.aiReview.players) {
        assert.ok(shown.has(p.seatIndex) && !p.folded, '게스트는 쇼다운까지 간 AI만 받아야 함');
        sawShowdownForGuest = true;
      }
      const guestJson = JSON.stringify(v.guest);
      for (const p of v.host.aiReview.players) {
        if (p.folded) {
          sawFoldedForHost = true;
          assert.ok(p.holeCards.length === 2);
          for (const c of p.holeCards) assert.ok(!guestJson.includes(c), `게스트 페이로드에 폴드한 AI 카드(${c})가 유출됨`);
        }
      }
    }
    assert.ok(sawFoldedForHost, '호스트 뷰에 폴드한 AI가 최소 한 번은 있어야 검증 의미가 있음');
    assert.ok(sawShowdownForGuest, '게스트 뷰에 쇼다운 AI가 최소 한 번은 있어야 검증 의미가 있음');
  });

  await check('showAiReview=false: 방 생성 시 꺼두면 호스트에게도 리뷰가 없고 기록도 안 함', async () => {
    const table = makeTable({ showAiReview: false });
    const views = await collect(table, 8, 15000);
    assert.ok(views.length >= 3);
    for (const v of views) {
      assert.strictEqual(v.host.aiReview, undefined);
      assert.strictEqual(v.guest.aiReview, undefined);
      assert.strictEqual(v.review, null);
    }
  });

  await check('showAiReview 설정: 로비/진행 중 모두 호스트만 변경 가능, 기본값은 켜짐', async () => {
    const table = makeTable();
    assert.strictEqual(table.config.showAiReview, true);
    assert.throws(() => table.updateConfig('guest1', { showAiReview: false }), /호스트만/);
    table.updateConfig('host1', { showAiReview: false });
    assert.strictEqual(table.config.showAiReview, false);
    table.start();
    table.updateConfig('host1', { showAiReview: true }); // 진행 중에도 변경 가능
    assert.strictEqual(table.config.showAiReview, true);
    table._closeRoom('test done');
  });

  await check('진행 중 토글 OFF: 이후 핸드부터 리뷰가 사라짐', async () => {
    const table = makeTable();
    const views = [];
    let toggled = false;
    table.on('handResult', () => {
      views.push({ off: toggled, host: table.getHandResultFor('host1') });
      if (views.length === 3 && !toggled) { table.updateConfig('host1', { showAiReview: false }); toggled = true; }
    });
    table.start();
    const t0 = Date.now();
    while (views.length < 8 && Date.now() - t0 < 20000) await wait(50);
    table._closeRoom('test done');
    const before = views.filter((v) => !v.off);
    const after = views.filter((v) => v.off);
    assert.ok(before.length >= 3 && after.length >= 2);
    assert.ok(before.every((v) => v.host.aiReview));
    assert.ok(after.every((v) => !v.host.aiReview), '토글 OFF 이후 핸드에는 리뷰가 없어야 함');
  });

  await check('재접속 복구(getReconnectExtras)도 권한별로 걸러진 리뷰를 돌려줌', async () => {
    const table = makeTable();
    let snapshot = null;
    table.on('handResult', () => {
      if (snapshot) return;
      snapshot = { host: table.getReconnectExtras('host1'), guest: table.getReconnectExtras('guest1'), raw: table._lastHandResult, review: table._lastHandReview };
    });
    table.start();
    const t0 = Date.now();
    while (!snapshot && Date.now() - t0 < 10000) await wait(30);
    table._closeRoom('test done');
    assert.ok(snapshot && snapshot.host.handResult.aiReview.scope === 'all');
    assert.strictEqual(snapshot.guest.handResult.aiReview.scope, 'showdown');
    const shown = new Set((snapshot.raw.showdown || []).map((p) => p.seatIndex));
    for (const p of snapshot.guest.handResult.aiReview.players) assert.ok(shown.has(p.seatIndex) && !p.folded);
  });

  await check('sanitize: reason/meta는 그대로 통과, 불법 액션 보정 시 보정 사실이 reason에 덧붙음', () => {
    const { sanitize } = require('../src/ai/AIDecisionEngine');
    const legal = { canRaise: false, canCall: true, canCheck: false, canFold: true, minRaiseTo: 200, maxRaiseTo: 1000, callAmount: 100 };
    const ok = sanitize(legal, { actionType: 'call', reason: '테스트 이유', meta: { equity: 0.5 } });
    assert.strictEqual(ok.reason, '테스트 이유');
    assert.deepStrictEqual(ok.meta, { equity: 0.5 });
    const fixed = sanitize(legal, { actionType: 'raise', amount: 400, reason: '레이즈 이유' });
    assert.strictEqual(fixed.actionType, 'call');
    assert.ok(fixed.reason.includes('레이즈 이유') && fixed.reason.includes('규칙상 할 수 없어'));
    const none = sanitize(legal, { actionType: 'call' });
    assert.strictEqual(none.reason, undefined);
  });

  await check('호스트가 접속해 있으면 "다음 핸드 시작"을 누르기 전에는 (오래 기다려도) 자동으로 넘어가지 않음', async () => {
    const table = new TableManager({
      hostId: 'host1', hostName: '호스트', aiCount: 2, startingStack: 20000,
      interHandDelayMs: 10, aiActionDelayMs: 0, allinRevealDelayMs: 0, maxRebuys: 999, shuffleSeatsOnStart: false,
    });
    let handsStarted = 0;
    table.on('state', () => { if (table.engine.handNumber > handsStarted) handsStarted = table.engine.handNumber; });
    // 호스트는 체크/콜만 해서 핸드를 끝까지 보내고, 결과 후 "다음 핸드"는 일부러 누르지 않는다.
    const act = () => {
      const e = table.engine;
      if (e.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = e.seats[e.actingSeat];
      if (!seat || seat.type !== 'human') return;
      const legal = e.getLegalActions(e.actingSeat);
      try { table.handleAction('host1', legal.canCheck ? 'check' : 'call', 0); } catch (err) { /* 무시 */ }
    };
    table.on('state', act);
    let awaiting = false;
    table.on('awaitNextHand', () => { awaiting = true; });
    // 안전장치 시간을 실제로 줄여서(원래 60초) 테스트가 빨리 끝나게 하되, 호스트가 있으면 안 걸려야 함을 검증
    table.start();
    const t0 = Date.now();
    while (!awaiting && Date.now() - t0 < 15000) await wait(30);
    assert.ok(awaiting, '핸드가 끝나고 다음 핸드 대기 상태가 되어야 함');
    const handAtWait = table.engine.handNumber;
    // 예전 안전장치(20초)가 지날 만큼 오래 기다리는 대신, 타이머가 걸려 있는지를 직접 확인한다.
    assert.ok(!table._nextHandFallbackTimer || table._nextHandFallbackTimer._destroyed || table._nextHandFallbackTimer._idleTimeout === -1,
      '호스트가 접속해 있는데 자동 진행 안전장치 타이머가 걸려 있으면 안 됨');
    await wait(1500);
    assert.strictEqual(table.engine.handNumber, handAtWait, '호스트가 누르기 전에는 다음 핸드가 시작되면 안 됨');
    // 호스트가 누르면 정상적으로 다음 핸드로
    table.handleReadyForNextHand('host1');
    await wait(300);
    assert.ok(table.engine.handNumber > handAtWait, '호스트가 누르면 다음 핸드가 시작되어야 함');
    table._closeRoom('test done');
  });

  await check('호스트 접속이 끊기면 그때만 안전장치가 걸리고, 돌아오면 다시 풀림', async () => {
    const table = new TableManager({
      hostId: 'host1', hostName: '호스트', aiCount: 1, startingStack: 20000,
      interHandDelayMs: 10, aiActionDelayMs: 0, allinRevealDelayMs: 0, maxRebuys: 999, shuffleSeatsOnStart: false,
    });
    table.addGuest('guest1', '게스트');
    const act = () => {
      const e = table.engine;
      if (e.actingSeat === -1 || table.status !== 'in_progress') return;
      const seat = e.seats[e.actingSeat];
      if (!seat || seat.type !== 'human') return;
      const legal = e.getLegalActions(e.actingSeat);
      try { table.handleAction(seat.playerId, legal.canCheck ? 'check' : 'call', 0); } catch (err) { /* 무시 */ }
    };
    table.on('state', act);
    let awaiting = false;
    table.on('awaitNextHand', () => { awaiting = true; });
    table.start();
    const t0 = Date.now();
    while (!awaiting && Date.now() - t0 < 15000) await wait(30);
    assert.ok(awaiting);
    const active = (t) => !!t && !t._destroyed && t._idleTimeout !== -1;
    assert.ok(!active(table._nextHandFallbackTimer), '호스트 접속 중에는 안전장치 없음');
    table.disconnect('host1');
    assert.ok(active(table._nextHandFallbackTimer), '호스트가 끊기면 안전장치가 걸려야 함(남은 사람이 막히지 않도록)');
    table.reconnect('host1');
    assert.ok(!active(table._nextHandFallbackTimer), '호스트가 돌아오면 안전장치가 풀려야 함');
    table._closeRoom('test done');
  });

  console.log(`AI 액션 리뷰: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
