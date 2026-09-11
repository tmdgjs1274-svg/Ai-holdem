'use strict';

const EventEmitter = require('events');
const { GameEngine } = require('../game/GameEngine');
const { BlindStructure } = require('../game/BlindStructure');
const { decideAction } = require('../ai/AIDecisionEngine');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동되는 0/O, 1/I 제외

function generateRoomCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

const AI_NAMES = ['봇 알파', '봇 브라보', '봇 찰리', '봇 델타', '봇 에코', '봇 폭스트롯', '봇 골프', '봇 호텔'];

// 로비(시작 전)에서는 폭넓게, 게임 진행 중에는 안전한 항목만 수정 허용
const LOBBY_EDITABLE = new Set([
  'aiCount', 'startingStack', 'rebuyAmount', 'startSb', 'startBb',
  'levelDurationMinutes', 'aiAutoRebuy', 'aiMistakeRate', 'aiActionDelayMs',
  'maxRebuys', 'addOnAmount', 'interHandDelayMs',
]);
const LIVE_EDITABLE = new Set([
  'aiMistakeRate', 'aiActionDelayMs', 'rebuyAmount', 'maxRebuys', 'addOnAmount',
  'aiAutoRebuy', 'interHandDelayMs',
]);

class TableManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.hostId
   * @param {string} config.hostName
   * @param {number} config.aiCount 0~7
   * @param {number} [config.maxSeats] 기본 9
   * @param {number} config.startingStack
   * @param {number} config.rebuyAmount
   * @param {number} [config.startSb] 기본 100
   * @param {number} [config.startBb] 기본 200
   * @param {number} [config.levelDurationMinutes] 0이면 블라인드 고정
   * @param {boolean} [config.aiAutoRebuy] 기본 true
   * @param {number} [config.aiMistakeRate] 0~1, 기본 0.08
   * @param {number} [config.interHandDelayMs] 핸드 사이 대기시간, 기본 3500
   * @param {number} [config.aiActionDelayMs] AI 액션 사이 텀, 기본 5000
   * @param {number} [config.maxRebuys] 0=무제한, 기본 0
   * @param {number} [config.addOnAmount] 0=비활성화, 기본 0
   */
  constructor(config) {
    super();
    this.roomId = generateRoomCode();
    this.hostId = config.hostId;
    this.maxSeats = Math.min(config.maxSeats || 9, 9);
    this.config = {
      startingStack: config.startingStack || 20000,
      rebuyAmount: config.rebuyAmount || config.startingStack || 20000,
      aiAutoRebuy: config.aiAutoRebuy !== false,
      aiMistakeRate: config.aiMistakeRate != null ? config.aiMistakeRate : 0.08,
      interHandDelayMs: config.interHandDelayMs != null ? config.interHandDelayMs : 5000,
      aiActionDelayMs: config.aiActionDelayMs != null ? config.aiActionDelayMs : 5000,
      maxRebuys: config.maxRebuys != null ? config.maxRebuys : 0,
      addOnAmount: config.addOnAmount != null ? config.addOnAmount : 0,
      aiCount: Math.max(0, Math.min(config.aiCount || 0, this.maxSeats - 1)),
      // 아래 3개는 블라인드 구조 표시용 미러(mirror) 필드 — 실제 값은 this.blinds가 갖고 있음
      startSb: config.startSb || 100,
      startBb: config.startBb || 200,
      levelDurationMinutes: config.levelDurationMinutes != null ? config.levelDurationMinutes : 15,
    };

    this.engine = new GameEngine({ maxSeats: this.maxSeats, rng: config.rng || Math.random });
    this.engine.on('action', (record) => this.emit('playerAction', record));

    this.blinds = new BlindStructure({
      startSb: this.config.startSb,
      startBb: this.config.startBb,
      levelDurationMinutes: this.config.levelDurationMinutes,
    });
    this.engine.setBlinds(this.blinds.getCurrent().sb, this.blinds.getCurrent().bb, this.blinds.getCurrent().ante);

    this.status = 'lobby'; // lobby | in_progress | closed
    this.humanBySeat = {}; // seatIndex -> { playerId, displayName, connected }
    this.seatByPlayer = {}; // playerId -> seatIndex
    this.pendingRebuy = new Set(); // seatIndex
    this.rebuyCounts = {}; // seatIndex -> 리바인 사용 횟수 (인간만)
    this.addOnUsed = new Set(); // seatIndex (애드온을 이미 쓴 인간 좌석)
    this.readyForNext = new Set(); // 다음 핸드 준비 완료를 누른 인간 좌석
    this._lastHandEndedNumber = null; // _onHandEnd 중복 호출 방지용
    this._handTimer = null;
    this._nextHandFallbackTimer = null;
    this._aiLoopActive = false;

    // 호스트 착석 (seat 0)
    this._seatHuman(0, config.hostId, config.hostName || '호스트');
    // AI 좌석은 seat 2번부터 채움 (seat 1은 게스트용으로 비워둠)
    this._resizeAiSeats(this.config.aiCount);
  }

  _seatHuman(seatIndex, playerId, displayName) {
    this.engine.seatPlayer(seatIndex, {
      playerId,
      displayName,
      type: 'human',
      stack: this.config.startingStack,
    });
    this.humanBySeat[seatIndex] = { playerId, displayName, connected: true };
    this.seatByPlayer[playerId] = seatIndex;
    this.rebuyCounts[seatIndex] = 0;
  }

  _resizeAiSeats(targetCount) {
    const currentAiSeats = this.engine.seats.filter((s) => s && s.type === 'ai');
    if (targetCount > currentAiSeats.length) {
      let seated = currentAiSeats.length;
      for (let seatIdx = 0; seatIdx < this.maxSeats && seated < targetCount; seatIdx++) {
        if (seatIdx === 1) continue; // 게스트 전용 슬롯 보존
        if (this.engine.seats[seatIdx]) continue;
        this.engine.seatPlayer(seatIdx, {
          playerId: `ai-${seatIdx}`,
          displayName: AI_NAMES[seated % AI_NAMES.length],
          type: 'ai',
          stack: this.config.startingStack,
        });
        this.rebuyCounts[seatIdx] = 0;
        seated++;
      }
    } else if (targetCount < currentAiSeats.length) {
      let toRemove = currentAiSeats.length - targetCount;
      for (let i = currentAiSeats.length - 1; i >= 0 && toRemove > 0; i--) {
        this.engine.removeSeat(currentAiSeats[i].seatIndex);
        toRemove--;
      }
    }
  }

  // ---------- 참가 ----------

  isFull() {
    return this.humanBySeat[1] != null;
  }

  addGuest(playerId, displayName) {
    if (this.status !== 'lobby') throw new Error('이미 시작된 게임에는 새 인간 플레이어가 참가할 수 없습니다');
    if (this.isFull()) throw new Error('게스트 자리가 이미 차있습니다');
    this._seatHuman(1, playerId, displayName || '게스트');
    this.emit('playerJoined', { seatIndex: 1, playerId, displayName });
    return 1;
  }

  reconnect(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return null;
    this.humanBySeat[seatIdx].connected = true;
    clearTimeout(this._disconnectGuardTimer);
    return seatIdx;
  }

  disconnect(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return;
    this.humanBySeat[seatIdx].connected = false;
    this.emit('playerDisconnected', { seatIndex: seatIdx, playerId });
    this._scheduleDisconnectGuard();
  }

  // 접속이 끊긴 인간 플레이어의 차례가 왔는데 응답이 없으면 일정 시간 후 자동 체크/폴드 처리
  // (게스트가 창을 닫아버려도 게임이 멈추지 않도록 하는 안전장치)
  _scheduleDisconnectGuard() {
    clearTimeout(this._disconnectGuardTimer);
    if (this.status !== 'in_progress') return;
    const seatIdx = this.engine.actingSeat;
    if (seatIdx == null || seatIdx === -1) return;
    const seat = this.engine.seats[seatIdx];
    if (!seat || seat.type !== 'human') return;
    const meta = this.humanBySeat[seatIdx];
    if (!meta || meta.connected) return;

    this._disconnectGuardTimer = setTimeout(() => {
      if (this.status !== 'in_progress' || this.engine.actingSeat !== seatIdx) return;
      const legal = this.engine.getLegalActions(seatIdx);
      if (!legal) return;
      try {
        this.engine.applyAction(seatIdx, legal.canCheck ? 'check' : 'fold', 0);
        this._broadcastState();
        this._runAiLoop();
      } catch (e) {
        // 무시: 타이밍 경합으로 이미 처리된 액션
      }
    }, 12000);
  }

  _broadcastState() {
    this.emit('state', this.getPublicState());
    this._scheduleDisconnectGuard();
  }

  // ---------- 설정 변경 (로비: 폭넓게 / 진행 중: 일부만) ----------

  updateConfig(playerId, patch) {
    if (playerId !== this.hostId) throw new Error('호스트만 설정을 변경할 수 있습니다');
    if (this.status === 'closed') throw new Error('이미 종료된 방입니다');
    const editableSet = this.status === 'lobby' ? LOBBY_EDITABLE : LIVE_EDITABLE;
    const applied = {};
    for (const key of Object.keys(patch || {})) {
      if (editableSet.has(key)) applied[key] = patch[key];
    }

    if ('aiCount' in applied && this.status === 'lobby') {
      const n = Math.max(0, Math.min(Number(applied.aiCount) || 0, this.maxSeats - 1));
      this._resizeAiSeats(n);
      this.config.aiCount = n;
    }
    if ('startingStack' in applied && this.status === 'lobby') {
      const n = Math.max(100, Number(applied.startingStack) || this.config.startingStack);
      this.config.startingStack = n;
      for (const seat of this.engine.seats) if (seat) seat.stack = n;
    }
    if ('rebuyAmount' in applied) {
      this.config.rebuyAmount = Math.max(100, Number(applied.rebuyAmount) || this.config.rebuyAmount);
    }
    if (('startSb' in applied || 'startBb' in applied) && this.status === 'lobby') {
      const cur = this.blinds.levels[0];
      const sb = 'startSb' in applied ? Math.max(1, Number(applied.startSb) || cur.sb) : cur.sb;
      const bb = 'startBb' in applied ? Math.max(2, Number(applied.startBb) || cur.bb) : cur.bb;
      this.blinds = new BlindStructure({ startSb: sb, startBb: bb, levelDurationMinutes: this.blinds.levelDurationMinutes });
      this.engine.setBlinds(this.blinds.getCurrent().sb, this.blinds.getCurrent().bb, this.blinds.getCurrent().ante);
      this.config.startSb = sb;
      this.config.startBb = bb;
    }
    if ('levelDurationMinutes' in applied && this.status === 'lobby') {
      this.blinds.levelDurationMinutes = Math.max(0, Number(applied.levelDurationMinutes) || 0);
      this.config.levelDurationMinutes = this.blinds.levelDurationMinutes;
    }
    if ('aiAutoRebuy' in applied) this.config.aiAutoRebuy = !!applied.aiAutoRebuy;
    if ('aiMistakeRate' in applied) {
      this.config.aiMistakeRate = Math.max(0, Math.min(0.4, Number(applied.aiMistakeRate)));
    }
    if ('aiActionDelayMs' in applied) {
      this.config.aiActionDelayMs = Math.max(0, Math.min(15000, Number(applied.aiActionDelayMs)));
    }
    if ('maxRebuys' in applied) this.config.maxRebuys = Math.max(0, Number(applied.maxRebuys) || 0);
    if ('addOnAmount' in applied) this.config.addOnAmount = Math.max(0, Number(applied.addOnAmount) || 0);
    if ('interHandDelayMs' in applied) {
      this.config.interHandDelayMs = Math.max(500, Number(applied.interHandDelayMs) || this.config.interHandDelayMs);
    }

    this.emit('configUpdated', this.config);
    return this.config;
  }

  // ---------- 애드온 ----------

  useAddOn(playerId) {
    if (this.status !== 'in_progress') throw new Error('게임 진행 중에만 애드온을 사용할 수 있습니다');
    if (!this.config.addOnAmount || this.config.addOnAmount <= 0) throw new Error('애드온이 비활성화되어 있습니다');
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) throw new Error('참가자를 찾을 수 없습니다');
    if (this.addOnUsed.has(seatIdx)) throw new Error('이미 애드온을 사용했습니다');
    const seat = this.engine.seats[seatIdx];
    seat.stack += this.config.addOnAmount;
    this.addOnUsed.add(seatIdx);
    this.emit('addOnUsed', { seatIndex: seatIdx, amount: this.config.addOnAmount, stack: seat.stack });
    this._broadcastState();
  }

  // ---------- 게임 시작/진행 ----------

  start() {
    if (this.status !== 'lobby') throw new Error('이미 시작되었습니다');
    this.status = 'in_progress';
    this.blinds.start();
    this._applyBlindLevel();
    this.emit('gameStarted', this.getLobbyState());
    this._playNextHand();
  }

  _applyBlindLevel() {
    const level = this.blinds.getCurrent();
    this.engine.setBlinds(level.sb, level.bb, level.ante);
    this.emit('blindLevel', level);
    return level;
  }

  _playNextHand() {
    if (this.status !== 'in_progress') return;
    if (this.pendingRebuy.size > 0) return; // 리바인 대기 중이면 다음 핸드 보류

    this._applyBlindLevel();

    if (!this.engine.canStartHand()) {
      // 인간이 아무도 없거나(모두 나감) 혹은 참가자가 1명 이하 -> 종료
      this._closeRoom('참가자 부족으로 게임이 종료되었습니다');
      return;
    }

    this.engine.startHand();
    this._broadcastState();
    this._runAiLoop();
  }

  // 이번 핸드에 사람(human) 좌석이 아직 폴드하지 않고 남아있는지 여부.
  // 사람이 전부 죽은 뒤의 AI vs AI 진행은 텀 없이 빠르게 처리하기 위함.
  _humanStillInHand() {
    for (const seatIdxStr of Object.keys(this.humanBySeat)) {
      const seatIdx = Number(seatIdxStr);
      const hs = this.engine.hs && this.engine.hs[seatIdx];
      if (hs && hs.inHand && !hs.folded) return true;
    }
    return false;
  }

  // AI 차례를 설정된 텀(aiActionDelayMs)을 두고 한 번에 하나씩 처리. 재진입 방지 가드 포함.
  _runAiLoop() {
    if (this._aiLoopActive) return;
    this._aiLoopActive = true;
    this._aiLoopStep();
  }

  _aiLoopStep() {
    if (this.status !== 'in_progress') {
      this._aiLoopActive = false;
      return;
    }
    if (this.engine.street === 'showdown') {
      this._aiLoopActive = false;
      this._onHandEnd();
      return;
    }
    if (this.engine.actingSeat === -1) {
      this._aiLoopActive = false;
      return;
    }
    const seat = this.engine.seats[this.engine.actingSeat];
    if (!seat || seat.type !== 'ai') {
      this._aiLoopActive = false;
      return; // 인간 차례 -> 클라이언트 액션 대기
    }

    const decision = decideAction(this.engine, seat.seatIndex, { mistakeRate: this.config.aiMistakeRate });
    // 사람이 이번 핸드에서 이미 전부 죽었다면(폴드/미참여) AI끼리만 남은 상황이므로
    // 굳이 텀을 두지 않고 빠르게 진행한다 (아무도 지켜볼 필요가 없는 AI vs AI 액션)
    const delay = this._humanStillInHand() ? Math.max(0, this.config.aiActionDelayMs || 0) : 0;
    clearTimeout(this._aiActionTimer);
    this._aiActionTimer = setTimeout(() => {
      if (this.status !== 'in_progress' || this.engine.actingSeat !== seat.seatIndex) {
        this._aiLoopActive = false;
        return;
      }
      try {
        this.engine.applyAction(seat.seatIndex, decision.actionType, decision.amount || 0);
      } catch (e) {
        this._aiLoopActive = false;
        return;
      }
      this._broadcastState();
      this._aiLoopStep();
    }, delay);
  }

  handleAction(playerId, actionType, amount) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) throw new Error('참가자를 찾을 수 없습니다');
    if (this.engine.actingSeat !== seatIdx) throw new Error('지금은 당신의 차례가 아닙니다');
    this.engine.applyAction(seatIdx, actionType, amount || 0);
    this._broadcastState();
    this._runAiLoop();
  }

  // 이번 핸드 종료 시점에 사람 좌석이 (폴드하지 않고) 하나라도 살아있었는지.
  // true면 결과 화면에서 "다음 핸드 준비" 확인을 기다리고, false면 자동으로 짧게 넘어간다.
  _wasAnyHumanActiveThisHand() {
    const humanSeats = Object.keys(this.humanBySeat).map(Number);
    return humanSeats.some((idx) => {
      const hs = this.engine.hs && this.engine.hs[idx];
      return hs && hs.inHand && !hs.folded;
    });
  }

  _onHandEnd() {
    // 재진입 방지: _aiLoopActive 가드가 _onHandEnd 호출 "직전"에 풀리기 때문에,
    // 그 사이에 다른 경로(중첩된 handleAction 등)로 _runAiLoop가 다시 호출되면
    // 같은 핸드에 대해 _onHandEnd가 중복 실행될 수 있다. 핸드 번호 기준으로 한 번만 처리한다.
    if (this._lastHandEndedNumber === this.engine.handNumber) return;
    this._lastHandEndedNumber = this.engine.handNumber;

    const requiresConfirm = this._wasAnyHumanActiveThisHand();
    this.emit('handResult', { ...this.engine.lastHandResult, requiresConfirm });

    // 파산자 처리
    const busted = this.engine.occupiedSeats().filter((s) => s.stack <= 0);
    let needsPause = false;
    for (const seat of busted) {
      if (seat.type === 'ai') {
        const used = this.rebuyCounts[seat.seatIndex] || 0;
        if (this.config.aiAutoRebuy && !(this.config.maxRebuys > 0 && used >= this.config.maxRebuys)) {
          this.rebuyCounts[seat.seatIndex] = used + 1;
          seat.stack = this.config.rebuyAmount;
          this.emit('aiRebuy', { seatIndex: seat.seatIndex, stack: seat.stack, rebuysUsed: this.rebuyCounts[seat.seatIndex] });
        } else {
          seat.isSittingOut = true;
        }
      } else {
        const used = this.rebuyCounts[seat.seatIndex] || 0;
        if (this.config.maxRebuys > 0 && used >= this.config.maxRebuys) {
          // 최대 리바인 횟수 초과 -> 리바인 거부와 동일하게 처리
          this._leaveOnBust(seat.seatIndex, seat.playerId, 'maxRebuysReached');
        } else {
          this.pendingRebuy.add(seat.seatIndex);
          needsPause = true;
          this.emit('rebuyRequired', {
            seatIndex: seat.seatIndex,
            playerId: seat.playerId,
            rebuysUsed: used,
            maxRebuys: this.config.maxRebuys,
          });
        }
      }
    }

    if (needsPause) return; // handleRebuyDecision에서 이어감

    this._afterHandEndScheduling();
  }

  // 핸드 종료 후 다음 핸드로 넘어가는 방식을 결정한다.
  // - 사람이 전부 이번 핸드에서 죽었다면(폴드) 지켜볼 사람이 없으므로 예전처럼 짧게 자동 진행.
  // - 사람이 한 명이라도 살아있었다면, 결과 화면을 모든 사람이 확인(다음 핸드 준비)할 때까지 대기.
  _afterHandEndScheduling() {
    this.readyForNext.clear();
    const humanSeats = Object.keys(this.humanBySeat).map(Number);
    const humanWasActive = this._wasAnyHumanActiveThisHand();

    if (!humanWasActive) {
      // 지켜볼 사람이 없는 핸드(사람 전원 폴드)는 예전처럼 결과만 짧게 보여주고 자동 진행
      this._scheduleNextHand(this.config.interHandDelayMs);
      return;
    }

    clearTimeout(this._handTimer);
    this.emit('awaitNextHand', { humanSeats });
    clearTimeout(this._nextHandFallbackTimer);
    // 응답 없는(자리 비움) 플레이어 때문에 게임이 영원히 멈추지 않도록 하는 안전장치
    this._nextHandFallbackTimer = setTimeout(() => this._playNextHand(), 20000);
  }

  handleReadyForNextHand(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return;
    if (this.status !== 'in_progress' || this.pendingRebuy.size > 0) return;
    this.readyForNext.add(seatIdx);
    this.emit('readyStateChanged', { readySeats: [...this.readyForNext] });

    const humanSeats = Object.keys(this.humanBySeat).map(Number);
    const allReady = humanSeats.length > 0 && humanSeats.every((idx) => this.readyForNext.has(idx));
    if (allReady) {
      clearTimeout(this._nextHandFallbackTimer);
      this._scheduleNextHand(0);
    }
  }

  _scheduleNextHand(delayMs) {
    clearTimeout(this._handTimer);
    clearTimeout(this._nextHandFallbackTimer);
    const delay = delayMs != null ? delayMs : this.config.interHandDelayMs;
    this._handTimer = setTimeout(() => this._playNextHand(), delay);
  }

  _leaveOnBust(seatIndex, playerId, reason) {
    const seat = this.engine.seats[seatIndex];
    if (!seat) return;
    seat.isSittingOut = true;
    this.emit('rebuyResult', { seatIndex, accepted: false, reason });
    if (seatIndex === 0) {
      // 호스트가 더 이상 플레이할 수 없음 -> 게임 종료
      const msg =
        reason === 'maxRebuysReached'
          ? '호스트가 최대 리바인 횟수에 도달해 게임이 종료되었습니다'
          : '호스트가 리바인을 하지 않아 게임이 종료되었습니다';
      this._closeRoom(msg);
      return;
    }
    // 게스트인 경우: 게스트만 퇴장, 게임은 계속 진행
    this.engine.removeSeat(seatIndex);
    delete this.humanBySeat[seatIndex];
    delete this.seatByPlayer[playerId];
  }

  handleRebuyDecision(playerId, accept) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null || !this.pendingRebuy.has(seatIdx)) return;
    this.pendingRebuy.delete(seatIdx);
    const seat = this.engine.seats[seatIdx];

    if (accept) {
      this.rebuyCounts[seatIdx] = (this.rebuyCounts[seatIdx] || 0) + 1;
      seat.stack = this.config.rebuyAmount;
      seat.isSittingOut = false;
      this.emit('rebuyResult', {
        seatIndex: seatIdx,
        accepted: true,
        stack: seat.stack,
        rebuysUsed: this.rebuyCounts[seatIdx],
      });
    } else {
      this._leaveOnBust(seatIdx, playerId, 'declined');
    }

    if (this.pendingRebuy.size === 0 && this.status === 'in_progress') {
      this._afterHandEndScheduling();
    }
  }

  _closeRoom(reason) {
    this.status = 'closed';
    clearTimeout(this._handTimer);
    clearTimeout(this._disconnectGuardTimer);
    clearTimeout(this._aiActionTimer);
    clearTimeout(this._nextHandFallbackTimer);
    this._aiLoopActive = false;
    this.emit('roomClosed', { reason });
  }

  closeByHost(playerId) {
    if (playerId !== this.hostId) throw new Error('호스트만 게임을 종료할 수 있습니다');
    this._closeRoom('호스트가 게임을 종료했습니다');
  }

  // ---------- 상태 조회 ----------

  getLobbyState() {
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      status: this.status,
      maxSeats: this.maxSeats,
      config: this.config,
      seats: this.engine.seats.map((s) => (s ? { seatIndex: s.seatIndex, displayName: s.displayName, type: s.type, stack: s.stack } : null)),
      blindLevel: this.blinds.getCurrent(),
    };
  }

  getPublicState(forPlayerId = null) {
    const forSeat = forPlayerId != null ? this.seatByPlayer[forPlayerId] : null;
    const base = {
      roomId: this.roomId,
      status: this.status,
      config: this.config,
      blindLevel: this.blinds.getCurrent(),
      pendingRebuySeats: [...this.pendingRebuy],
      mySeatIndex: forSeat != null ? forSeat : null,
      hostId: this.hostId,
      addOnAvailable:
        this.config.addOnAmount > 0 && forSeat != null && !this.addOnUsed.has(forSeat) && this.status === 'in_progress',
      ...this.engine.getPublicState(forSeat),
    };
    if (forSeat != null && this.engine.actingSeat === forSeat) {
      base.legalActions = this.engine.getLegalActions(forSeat);
    }
    return base;
  }
}

module.exports = { TableManager, generateRoomCode };
