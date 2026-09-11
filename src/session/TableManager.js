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

class TableManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.hostId
   * @param {string} config.hostName
   * @param {number} config.aiCount 0~7
   * @param {number} [config.maxSeats] 기본 9
   * @param {number} config.startingStack
   * @param {number} config.rebuyAmount
   * @param {number} [config.startSb]
   * @param {number} [config.startBb]
   * @param {number} [config.levelDurationMinutes] 0이면 블라인드 고정
   * @param {boolean} [config.aiAutoRebuy] 기본 true
   * @param {number} [config.aiMistakeRate] 0~1, 기본 0.08
   * @param {number} [config.interHandDelayMs] 기본 3500
   */
  constructor(config) {
    super();
    this.roomId = generateRoomCode();
    this.hostId = config.hostId;
    this.maxSeats = Math.min(config.maxSeats || 9, 9);
    this.config = {
      startingStack: config.startingStack || 5000,
      rebuyAmount: config.rebuyAmount || config.startingStack || 5000,
      aiAutoRebuy: config.aiAutoRebuy !== false,
      aiMistakeRate: config.aiMistakeRate != null ? config.aiMistakeRate : 0.08,
      interHandDelayMs: config.interHandDelayMs != null ? config.interHandDelayMs : 3500,
      aiCount: Math.max(0, Math.min(config.aiCount || 0, this.maxSeats - 1)),
    };

    this.engine = new GameEngine({ maxSeats: this.maxSeats });
    this.blinds = new BlindStructure({
      startSb: config.startSb || 25,
      startBb: config.startBb || 50,
      levelDurationMinutes: config.levelDurationMinutes != null ? config.levelDurationMinutes : 15,
    });
    this.engine.setBlinds(this.blinds.getCurrent().sb, this.blinds.getCurrent().bb, this.blinds.getCurrent().ante);

    this.status = 'lobby'; // lobby | in_progress | closed
    this.humanBySeat = {}; // seatIndex -> { playerId, displayName, connected }
    this.seatByPlayer = {}; // playerId -> seatIndex
    this.pendingRebuy = new Set(); // seatIndex
    this._handTimer = null;

    // 호스트 착석 (seat 0)
    this._seatHuman(0, config.hostId, config.hostName || '호스트');
    // AI 좌석은 seat 2번부터 채움 (seat 1은 게스트용으로 비워둠)
    this._fillAiSeats();
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
  }

  _fillAiSeats() {
    let seated = 0;
    for (let seatIdx = 0; seatIdx < this.maxSeats && seated < this.config.aiCount; seatIdx++) {
      if (seatIdx === 1) continue; // 게스트 전용 슬롯 보존
      if (this.engine.seats[seatIdx]) continue;
      this.engine.seatPlayer(seatIdx, {
        playerId: `ai-${seatIdx}`,
        displayName: AI_NAMES[seated % AI_NAMES.length],
        type: 'ai',
        stack: this.config.startingStack,
      });
      seated++;
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

  _runAiLoop() {
    // actingSeat가 AI인 동안 자동으로 AI 액션을 진행. 핸드가 끝나면 결과 처리.
    while (this.engine.street !== 'showdown' && this.engine.actingSeat !== -1) {
      const seat = this.engine.seats[this.engine.actingSeat];
      if (!seat || seat.type !== 'ai') break; // 인간 차례 -> 클라이언트 액션 대기
      const legal = this.engine.getLegalActions(seat.seatIndex);
      const decision = decideAction(this.engine, seat.seatIndex, {
        mistakeRate: this.config.aiMistakeRate,
      });
      this.engine.applyAction(seat.seatIndex, decision.actionType, decision.amount || 0);
      this._broadcastState();
    }
    if (this.engine.street === 'showdown') {
      this._onHandEnd();
    }
  }

  handleAction(playerId, actionType, amount) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) throw new Error('참가자를 찾을 수 없습니다');
    if (this.engine.actingSeat !== seatIdx) throw new Error('지금은 당신의 차례가 아닙니다');
    this.engine.applyAction(seatIdx, actionType, amount || 0);
    this._broadcastState();
    this._runAiLoop();
  }

  _onHandEnd() {
    this.emit('handResult', this.engine.lastHandResult);

    // 파산자 처리
    const busted = this.engine.occupiedSeats().filter((s) => s.stack <= 0);
    let needsPause = false;
    for (const seat of busted) {
      if (seat.type === 'ai') {
        if (this.config.aiAutoRebuy) {
          seat.stack = this.config.rebuyAmount;
          this.emit('aiRebuy', { seatIndex: seat.seatIndex, stack: seat.stack });
        } else {
          seat.isSittingOut = true;
        }
      } else {
        this.pendingRebuy.add(seat.seatIndex);
        needsPause = true;
        this.emit('rebuyRequired', { seatIndex: seat.seatIndex, playerId: seat.playerId });
      }
    }

    if (needsPause) return; // handleRebuyDecision에서 이어감

    this._scheduleNextHand();
  }

  _scheduleNextHand() {
    clearTimeout(this._handTimer);
    this._handTimer = setTimeout(() => this._playNextHand(), this.config.interHandDelayMs);
  }

  handleRebuyDecision(playerId, accept) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null || !this.pendingRebuy.has(seatIdx)) return;
    this.pendingRebuy.delete(seatIdx);
    const seat = this.engine.seats[seatIdx];

    if (accept) {
      seat.stack = this.config.rebuyAmount;
      seat.isSittingOut = false;
      this.emit('rebuyResult', { seatIndex: seatIdx, accepted: true, stack: seat.stack });
    } else {
      seat.isSittingOut = true;
      this.emit('rebuyResult', { seatIndex: seatIdx, accepted: false });
      if (seatIdx === 0) {
        // 호스트가 리바인을 거부 -> 게임 종료
        this._closeRoom('호스트가 리바인을 하지 않아 게임이 종료되었습니다');
        return;
      }
      // 게스트가 거부한 경우: 게스트만 퇴장, 게임은 계속 진행
      this.engine.removeSeat(seatIdx);
      delete this.humanBySeat[seatIdx];
      delete this.seatByPlayer[playerId];
    }

    if (this.pendingRebuy.size === 0 && this.status === 'in_progress') {
      this._scheduleNextHand();
    }
  }

  _closeRoom(reason) {
    this.status = 'closed';
    clearTimeout(this._handTimer);
    clearTimeout(this._disconnectGuardTimer);
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
      blindLevel: this.blinds.getCurrent(),
      pendingRebuySeats: [...this.pendingRebuy],
      mySeatIndex: forSeat != null ? forSeat : null,
      hostId: this.hostId,
      ...this.engine.getPublicState(forSeat),
    };
    if (forSeat != null && this.engine.actingSeat === forSeat) {
      base.legalActions = this.engine.getLegalActions(forSeat);
    }
    return base;
  }
}

module.exports = { TableManager, generateRoomCode };
