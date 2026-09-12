'use strict';

const EventEmitter = require('events');
const { GameEngine } = require('../game/GameEngine');
const { BlindStructure, generateDefaultLevels } = require('../game/BlindStructure');
const { decideAction } = require('../ai/AIDecisionEngine');
const { cardToString } = require('../game/Deck');

// 블라인드 구조에 한 번에 넣을 수 있는 레벨 수 상한(휴식 포함). 실수로 수백 개를 넣는 것을 방지.
const MAX_BLIND_LEVELS = 60;

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동되는 0/O, 1/I 제외

function generateRoomCode(len = 4) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

const AI_NAMES = ['봇 알파', '봇 브라보', '봇 찰리', '봇 델타', '봇 에코', '봇 폭스트롯', '봇 골프', '봇 호텔'];

// 로비(시작 전)에서는 폭넓게, 게임 진행 중에는 안전한 항목만 수정 허용
const LOBBY_EDITABLE = new Set([
  'aiCount', 'startingStack', 'rebuyAmount', 'bbAnte', 'blindLevels',
  'aiMistakeRate', 'aiSkillLevel', 'aiActionDelayMs',
  'maxRebuys', 'addOnAmount', 'interHandDelayMs',
]);
const LIVE_EDITABLE = new Set([
  'aiMistakeRate', 'aiSkillLevel', 'aiActionDelayMs', 'rebuyAmount', 'maxRebuys', 'addOnAmount',
  'interHandDelayMs',
]);

// 접속이 끊긴 사람이 이 시간(ms) 이상 재연결하지 못하면, 방에 계속 남아 다른 사람의
// "다음 핸드 준비" 대기를 영원히 막는 일이 없도록 실제로 나간 것으로 처리한다.
const DISCONNECT_LEAVE_MS = 45000;

// 올인 쇼다운(남은 스트리트를 한 번에 몰아서 진행하는 경우) 카드를 한 장씩 순서대로 공개할 때
// 카드 사이에 두는 텀(ms)
const ALLIN_REVEAL_DELAY_MS = 900;

class TableManager extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.hostId
   * @param {string} config.hostName
   * @param {number} config.aiCount 0~8 (사람이 늘어나면 실제로는 빈 좌석 수만큼만 채워짐)
   * @param {number} [config.maxSeats] 기본 9
   * @param {number} config.startingStack
   * @param {number} config.rebuyAmount
   * @param {Array} [config.blindLevels] 블라인드 구조(레벨 배열). 각 항목은
   *   { sb, bb, ante, durationMinutes, isBreak }. 생략하면 기본 12단계 표가 사용된다.
   *   레벨 추가/삭제/개별 금액·시간 수정은 로비에서만 가능하다(BlindStructure 참고).
   * @param {boolean} [config.bbAnte] BB 앤티(빅블라인드 좌석이 그 레벨 bb만큼 추가로 혼자 냄) 사용 여부, 기본 true.
   *   레벨을 직접 준 경우에는 각 레벨의 ante 값이 우선하며, 이 값은 기본표 생성 시에만 쓰인다.
   * @param {number} [config.aiMistakeRate] 0~1, 기본 0.08 (드문 큰 실수 빈도)
   * @param {number} [config.aiSkillLevel] 0~100, 기본 75 (기본 판단 정밀도/실력. 낮을수록 매 판단에 잡음이 커짐)
   * @param {number} [config.interHandDelayMs] 핸드 사이 대기시간, 기본 3500
   * @param {number} [config.aiActionDelayMs] AI 액션 사이 텀, 기본 5000
   * @param {number} [config.maxRebuys] 최대 리바인 횟수. 0=리바인 불가, 기본 0
   * @param {number} [config.addOnAmount] 0=비활성화, 기본 0
   * @param {boolean} [config.shuffleSeatsOnStart] 게임 시작 시 좌석을 무작위로 섞을지 여부. 기본 true(테스트 전용 옵션)
   */
  constructor(config) {
    super();
    this.roomId = generateRoomCode();
    this.hostId = config.hostId;
    this.maxSeats = Math.min(config.maxSeats || 9, 9);
    this.config = {
      startingStack: config.startingStack || 20000,
      // 기본 리바인 칩은 이제 시작 칩을 그대로 따라가지 않고 30,000으로 고정된 기본값을 갖는다.
      rebuyAmount: config.rebuyAmount || 30000,
      aiMistakeRate: config.aiMistakeRate != null ? config.aiMistakeRate : 0.08,
      aiSkillLevel: config.aiSkillLevel != null ? Math.max(0, Math.min(100, config.aiSkillLevel)) : 75,
      interHandDelayMs: config.interHandDelayMs != null ? config.interHandDelayMs : 5000,
      aiActionDelayMs: config.aiActionDelayMs != null ? config.aiActionDelayMs : 1500,
      // 0이면 리바인이 아예 불가능함을 의미한다(과거에는 0=무제한이었으나, 사람이 리바인을
      // 명시적으로 통제할 수 있도록 "무제한" 개념 자체를 없앴다). 기본값은 1회.
      maxRebuys: config.maxRebuys != null ? config.maxRebuys : 1,
      addOnAmount: config.addOnAmount != null ? config.addOnAmount : 0,
      // 올인 쇼다운에서 보드 카드를 한 장씩 공개할 때 카드 사이에 두는 텀(ms). 기본 900
      allinRevealDelayMs: config.allinRevealDelayMs != null ? config.allinRevealDelayMs : ALLIN_REVEAL_DELAY_MS,
      aiCount: Math.max(0, Math.min(config.aiCount || 0, this.maxSeats - 1)),
      bbAnte: config.bbAnte !== false,
    };

    this.rng = config.rng || Math.random;
    // 게임 시작 시 좌석 배치를 무작위로 섞을지 여부(기본 true). 테스트에서 좌석 인덱스를
    // 고정해두고 검증해야 할 때만 false로 끈다.
    this.shuffleSeatsOnStart = config.shuffleSeatsOnStart !== false;
    this.engine = new GameEngine({ maxSeats: this.maxSeats, rng: this.rng });
    this.engine.on('action', (record) => this.emit('playerAction', record));

    this.blinds = new BlindStructure({
      levels: config.blindLevels && config.blindLevels.length ? config.blindLevels : generateDefaultLevels(this.config.bbAnte),
      bbAnte: this.config.bbAnte,
    });
    // 화면 표시/재구성용으로 정규화된 레벨 배열을 config에도 미러링해둔다(실제 소스는 this.blinds).
    this.config.blindLevels = this.blinds.levels;
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
    // 재접속 시 놓친 "한 번뿐인" 이벤트(handResult/awaitNextHand/rebuyRequired)를 다시 보내주기 위한 상태
    this._lastHandResult = null;
    this._awaitingConfirmInfo = null; // { humanSeats } - 다음 핸드 준비 확인을 기다리는 중이면 설정됨
    // 파산한 AI가 있어서(사람이 아직 리바인을 결정하지 않아) 다음 핸드를 시작할 수 없는 상태
    this._awaitingAiRebuy = false;

    // 호스트 착석 (seat 0)
    this._seatHuman(0, config.hostId, config.hostName || '호스트');
    // AI 좌석은 맨 뒷자리(seat maxSeats-1)부터 거꾸로 채운다. 사람은 언제 몇 명이 더
    // 합류할지 로비 단계에서는 알 수 없으므로(최대 9명까지 가능), 낮은 인덱스의 좌석을
    // 최대한 비워둬서 나중에 합류하는 사람들이 앉을 자리를 확보한다.
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
      // 좌석 1번(호스트 다음)부터가 아니라 맨 뒤(maxSeats-1)부터 거꾸로 채워서, 낮은
      // 인덱스의 좌석을 나중에 합류할 사람들을 위해 최대한 비워둔다.
      for (let seatIdx = this.maxSeats - 1; seatIdx >= 1 && seated < targetCount; seatIdx--) {
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
      // 제거할 때는 낮은 인덱스(사람이 우선 채워야 할 자리)의 AI부터 제거한다.
      const sorted = [...currentAiSeats].sort((a, b) => a.seatIndex - b.seatIndex);
      let toRemove = currentAiSeats.length - targetCount;
      for (let i = 0; i < sorted.length && toRemove > 0; i++) {
        this.engine.removeSeat(sorted[i].seatIndex);
        toRemove--;
      }
    }
  }

  // ---------- 참가 ----------

  // 사람이 앉을 수 있는 가장 낮은 인덱스의 빈 좌석(1번부터 maxSeats-1번까지). 없으면 null.
  _nextOpenHumanSeat() {
    for (let i = 1; i < this.maxSeats; i++) {
      if (!this.engine.seats[i]) return i;
    }
    return null;
  }

  isFull() {
    return this._nextOpenHumanSeat() == null;
  }

  addGuest(playerId, displayName) {
    if (this.status !== 'lobby') throw new Error('이미 시작된 게임에는 새 인간 플레이어가 참가할 수 없습니다');
    const seatIdx = this._nextOpenHumanSeat();
    if (seatIdx == null) throw new Error('방이 가득 찼습니다');
    this._seatHuman(seatIdx, playerId, displayName || '게스트');
    this.emit('playerJoined', { seatIndex: seatIdx, playerId, displayName });
    return seatIdx;
  }

  reconnect(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return null;
    this.humanBySeat[seatIdx].connected = true;
    this.humanBySeat[seatIdx].disconnectedAt = null;
    clearTimeout(this._disconnectGuardTimer);
    return seatIdx;
  }

  disconnect(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return;
    this.humanBySeat[seatIdx].connected = false;
    this.humanBySeat[seatIdx].disconnectedAt = Date.now();
    this.emit('playerDisconnected', { seatIndex: seatIdx, playerId });
    this._scheduleDisconnectGuard();
  }

  // 이번 핸드에 참여했는지와 무관하게, "지금 연결되어 있는" 사람 좌석만 골라낸다.
  // 접속이 끊긴 사람에게 결과 확인(다음 핸드 준비)을 무한정 기다리지 않기 위해 사용한다.
  _connectedHumanSeats() {
    return Object.keys(this.humanBySeat)
      .map(Number)
      .filter((idx) => this.humanBySeat[idx] && this.humanBySeat[idx].connected !== false);
  }

  // 접속이 끊긴 채로 DISCONNECT_LEAVE_MS 이상 재연결하지 못한 사람이 있으면, 핸드와 핸드
  // 사이의 안전한 시점에 실제로 "나간 것"으로 처리한다(호스트면 방 종료, 게스트면 퇴장 처리).
  // 반환값이 true면 방이 종료된 것이므로 호출부는 이어서 다음 핸드를 진행하면 안 된다.
  _reapLongDisconnectedHumans() {
    const now = Date.now();
    for (const seatIdxStr of Object.keys(this.humanBySeat)) {
      const seatIdx = Number(seatIdxStr);
      const meta = this.humanBySeat[seatIdx];
      if (!meta || meta.connected || !meta.disconnectedAt) continue;
      if (now - meta.disconnectedAt < DISCONNECT_LEAVE_MS) continue;

      const playerId = meta.playerId;
      if (seatIdx === 0) {
        this._closeRoom('호스트의 연결이 오래 끊겨 게임이 종료되었습니다');
        return true;
      }
      this.engine.removeSeat(seatIdx);
      delete this.humanBySeat[seatIdx];
      delete this.seatByPlayer[playerId];
      this.readyForNext.delete(seatIdx);
      this.emit('playerLeft', { seatIndex: seatIdx, playerId, reason: 'disconnected' });
      this._broadcastState();
    }
    return false;
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
    // 블라인드 구조(레벨 추가/삭제/개별 금액·시간 수정)는 로비에서만 통째로 교체할 수 있다.
    // 이미 게임이 시작된 뒤에 레벨을 넣고 빼면 "지금 몇 번째 레벨인지"가 불분명해지므로,
    // 실제 토너먼트 클럭처럼 시작 전에 구조를 확정하도록 한다.
    if ('blindLevels' in applied && this.status === 'lobby') {
      const incoming = Array.isArray(applied.blindLevels) ? applied.blindLevels.slice(0, MAX_BLIND_LEVELS) : [];
      if (incoming.length > 0) {
        this.blinds.replaceLevels(incoming);
        this.engine.setBlinds(this.blinds.getCurrent().sb, this.blinds.getCurrent().bb, this.blinds.getCurrent().ante);
        this.config.blindLevels = this.blinds.levels;
      }
    }
    // "BB 앤티 사용유무" 체크박스: 구조 편집기를 따로 열지 않고도 모든 (휴식이 아닌) 레벨의
    // 앤티를 한 번에 켜고 끌 수 있는 일괄 적용 스위치. 이후에도 편집기에서 레벨별로 다시
    // 개별 수정할 수 있다.
    if ('bbAnte' in applied && this.status === 'lobby') {
      const bbAnte = applied.bbAnte !== false;
      this.config.bbAnte = bbAnte;
      const newLevels = this.blinds.levels.map((lv) => (lv.isBreak ? lv : { ...lv, ante: bbAnte ? lv.bb : 0 }));
      this.blinds.replaceLevels(newLevels);
      this.engine.setBlinds(this.blinds.getCurrent().sb, this.blinds.getCurrent().bb, this.blinds.getCurrent().ante);
      this.config.blindLevels = this.blinds.levels;
    }
    if ('aiMistakeRate' in applied) {
      this.config.aiMistakeRate = Math.max(0, Math.min(0.4, Number(applied.aiMistakeRate)));
    }
    if ('aiSkillLevel' in applied) {
      this.config.aiSkillLevel = Math.max(0, Math.min(100, Number(applied.aiSkillLevel)));
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
    if (this.shuffleSeatsOnStart) this._shuffleSeats();
    this.blinds.start();
    this._applyBlindLevel();
    this.emit('gameStarted', this.getLobbyState());
    this._playNextHand();
  }

  // 게임 시작 시 좌석 배치를 무작위로 섞는다(입장 순서대로 앉는 대신). 어차피 게임이 시작되면
  // 새로운 사람이 더 합류할 수 없으므로(addGuest가 lobby 상태만 허용), 지금 채워져 있는
  // 좌석 인덱스 집합은 그대로 두고 그 자리에 누가 앉을지만 무작위로 재배치한다.
  // GameEngine.buttonIndex는 아직 -1(첫 핸드 시작 전)이라 버튼/포지션 관련 상태가 꼬일 일도 없다.
  _shuffleSeats() {
    const occupiedIdx = this.engine.seats.map((s, idx) => (s ? idx : null)).filter((idx) => idx != null);
    if (occupiedIdx.length < 2) return;

    const shuffledIdx = [...occupiedIdx];
    for (let i = shuffledIdx.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffledIdx[i], shuffledIdx[j]] = [shuffledIdx[j], shuffledIdx[i]];
    }

    const oldSeats = {};
    const oldRebuyCounts = { ...this.rebuyCounts };
    const oldAddOnUsed = new Set(this.addOnUsed);
    for (const idx of occupiedIdx) oldSeats[idx] = this.engine.seats[idx];

    for (const idx of occupiedIdx) this.engine.seats[idx] = null;
    this.humanBySeat = {};
    this.seatByPlayer = {};
    this.rebuyCounts = {};
    this.addOnUsed = new Set();

    occupiedIdx.forEach((oldIdx, i) => {
      const newIdx = shuffledIdx[i];
      const seatObj = oldSeats[oldIdx];
      seatObj.seatIndex = newIdx;
      this.engine.seats[newIdx] = seatObj;
      this.rebuyCounts[newIdx] = oldRebuyCounts[oldIdx] || 0;
      if (oldAddOnUsed.has(oldIdx)) this.addOnUsed.add(newIdx);
      if (seatObj.type === 'human') {
        this.humanBySeat[newIdx] = { playerId: seatObj.playerId, displayName: seatObj.displayName, connected: true };
        this.seatByPlayer[seatObj.playerId] = newIdx;
      }
    });
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
      if (this.engine.occupiedSeats().length < 2) {
        // 실제로 참가자가 부족함(사람이 나가는 등) -> 게임 종료
        this._closeRoom('참가자 부족으로 게임이 종료되었습니다');
      } else {
        // 좌석은 남아있지만(예: 파산한 AI가 아직 리바인되지 않음) 핸드를 시작할 조건이 안 되는 경우.
        // 방을 닫지 않고, 사람이 해당 AI를 수동으로 리바인시킬 때까지 대기한다.
        this._awaitingAiRebuy = true;
        this.emit('waitingForAiRebuy', {
          seats: this.engine.seats.filter((s) => s && s.isSittingOut).map((s) => s.seatIndex),
        });
      }
      return;
    }

    this._awaitingAiRebuy = false;
    this._lastHandResult = null;
    this._awaitingConfirmInfo = null;
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

    const decision = decideAction(this.engine, seat.seatIndex, {
      mistakeRate: this.config.aiMistakeRate,
      skillLevel: this.config.aiSkillLevel,
    });
    // 사람이 이번 핸드에서 이미 전부 죽었다면(폴드/미참여) AI끼리만 남은 상황이므로
    // 굳이 텀을 두지 않고 빠르게 진행한다 (아무도 지켜볼 필요가 없는 AI vs AI 액션)
    const delay = this._humanStillInHand() ? Math.max(0, this.config.aiActionDelayMs || 0) : 0;
    clearTimeout(this._aiActionTimer);
    this._aiActionTimer = setTimeout(() => {
      if (this.status !== 'in_progress' || this.engine.actingSeat !== seat.seatIndex) {
        this._aiLoopActive = false;
        return;
      }
      const boardLenBefore = this.engine.board.length;
      try {
        this.engine.applyAction(seat.seatIndex, decision.actionType, decision.amount || 0);
      } catch (e) {
        this._aiLoopActive = false;
        return;
      }
      this._revealBoardThenContinue(boardLenBefore, () => this._aiLoopStep());
    }, delay);
  }

  handleAction(playerId, actionType, amount) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) throw new Error('참가자를 찾을 수 없습니다');
    if (this.engine.actingSeat !== seatIdx) throw new Error('지금은 당신의 차례가 아닙니다');
    const boardLenBefore = this.engine.board.length;
    this.engine.applyAction(seatIdx, actionType, amount || 0);
    this._revealBoardThenContinue(boardLenBefore, () => this._runAiLoop());
  }

  // 올인 등으로 한 번의 액션에서 여러 장의 보드 카드가 한꺼번에 쇼다운까지 진행된 경우,
  // 실제로는 이미 엔진 내부 상태가 최종(쇼다운)까지 다 처리되어 있지만, 클라이언트에는
  // 카드를 한 장씩 순서대로(텀을 두고) 공개하는 것처럼 보여준다.
  // 사람이 아무도 지켜보고 있지 않다면(전원 폴드) 굳이 텀을 둘 필요가 없으므로 즉시 진행한다.
  _revealBoardThenContinue(boardLenBefore, continueFn) {
    const boardLenAfter = this.engine.board.length;
    const revealDelay = this.config.allinRevealDelayMs;
    const isAllInRunout =
      revealDelay > 0 && this.engine.street === 'showdown' && boardLenAfter > boardLenBefore && this._humanStillInHand();

    if (!isAllInRunout) {
      this._broadcastState();
      continueFn();
      return;
    }

    const fullBoard = this.engine.board.map(cardToString);
    let revealed = boardLenBefore;

    const revealNext = () => {
      if (this.status !== 'in_progress') return;
      revealed++;
      // 일반 'state'가 아니라 별도 이벤트로 보내야 한다: server.js의 'state' 리스너는 인자를
      // 무시하고 항상 현재(=이미 최종인) 엔진 상태를 새로 만들어 보내므로, 이 단계적 공개용
      // 스냅샷은 그 경로를 타면 안 된다(즉시 전체 보드가 보여버림).
      this.emit('boardReveal', { board: fullBoard.slice(0, revealed) });
      clearTimeout(this._boardRevealTimer);
      if (revealed < fullBoard.length) {
        this._boardRevealTimer = setTimeout(revealNext, revealDelay);
      } else {
        this._boardRevealTimer = setTimeout(() => {
          if (this.status !== 'in_progress') return;
          this._broadcastState();
          continueFn();
        }, revealDelay);
      }
    };
    revealNext();
  }

  // 이번 핸드에 사람 좌석이 (폴드 여부와 무관하게) 하나라도 참여(딜)했는지.
  // true면 결과 화면에서 "다음 핸드 준비" 확인을 기다리고, false(예: 사람이 리바인 대기 등으로
  // 이번 핸드를 아예 구경만 한 경우)면 자동으로 짧게 넘어간다.
  // 주의: 일찍 폴드했더라도 자기 핸드 결과는 직접 확인하고 넘기고 싶어하므로, 폴드 여부는 보지 않는다.
  _wasAnyHumanDealtThisHand() {
    const humanSeats = Object.keys(this.humanBySeat).map(Number);
    return humanSeats.some((idx) => {
      const hs = this.engine.hs && this.engine.hs[idx];
      return hs && hs.inHand;
    });
  }

  _onHandEnd() {
    // 재진입 방지: _aiLoopActive 가드가 _onHandEnd 호출 "직전"에 풀리기 때문에,
    // 그 사이에 다른 경로(중첩된 handleAction 등)로 _runAiLoop가 다시 호출되면
    // 같은 핸드에 대해 _onHandEnd가 중복 실행될 수 있다. 핸드 번호 기준으로 한 번만 처리한다.
    if (this._lastHandEndedNumber === this.engine.handNumber) return;
    this._lastHandEndedNumber = this.engine.handNumber;
    // 이번 핸드 결과에 대한 "준비 완료" 집합은 핸드당 한 번만 초기화한다. 파산자가 있어서
    // 리바인 결정을 기다리는 동안에도(=_afterHandEndScheduling이 나중에 다시 호출되는 동안에도)
    // 이미 눌러둔 "다음 핸드 준비" 클릭이 지워지지 않게 하기 위함
    // (예전에는 _afterHandEndScheduling이 호출될 때마다 지워서, 리바인 대기 중에 미리 누른
    //  클릭이 사라지고 서버도 그 클릭을 무시해 버려 상대가 준비를 눌러도 인식되지 않는 버그가 있었다).
    this.readyForNext.clear();

    const requiresConfirm = this._wasAnyHumanDealtThisHand();
    this._lastHandResult = { ...this.engine.lastHandResult, requiresConfirm };
    this.emit('handResult', this._lastHandResult);

    // 파산자 처리
    const busted = this.engine.occupiedSeats().filter((s) => s.stack <= 0);
    let needsPause = false;
    for (const seat of busted) {
      if (seat.type === 'ai') {
        const aiUsed = this.rebuyCounts[seat.seatIndex] || 0;
        if (aiUsed >= this.config.maxRebuys) {
          // 이 AI는 이미 리바인 한도를 다 썼거나(또는 maxRebuys=0이라 애초에 불가능함) ->
          // 사람에게 리바인 결정을 물어봐야 소용없으므로(항상 거부될 것이므로) 좌석에서
          // 완전히 제거한다. 그대로 sitting-out 상태로만 두면 아무도 리바인시킬 수 없는데도
          // canStartHand()가 영원히 실패해 게임이 멈춰버리는 문제가 있었다.
          this.emit('rebuyResult', { seatIndex: seat.seatIndex, accepted: false, reason: 'maxRebuysReached' });
          this.engine.removeSeat(seat.seatIndex);
          delete this.rebuyCounts[seat.seatIndex];
        } else {
          // 아직 리바인 여지가 있는 AI는 자동으로 리바인되지 않는다. 비활성화(sitting-out)
          // 상태로 두고, 사람이 좌석을 클릭해 리바인 여부를 직접 결정할 때까지 기다린다
          // (handleAiRebuyDecision).
          seat.isSittingOut = true;
        }
      } else {
        const used = this.rebuyCounts[seat.seatIndex] || 0;
        // maxRebuys=0은 "리바인 불가"를 의미한다(과거의 "무제한" 개념은 제거됨).
        if (used >= this.config.maxRebuys) {
          // 최대 리바인 횟수 초과(또는 애초에 리바인이 불가능함) -> 리바인 거부와 동일하게 처리
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
  // - 이번 핸드에 참여한 사람이 아예 없었다면(리바인 대기 등으로 구경만 함) 지켜볼 사람이 없으므로 예전처럼 짧게 자동 진행.
  // - 사람이 한 명이라도 참여했다면(폴드했어도) 자기 결과는 직접 확인하고 싶어하므로,
  //   결과 화면을 모든 사람이 확인(다음 핸드 준비)할 때까지 대기한다.
  _afterHandEndScheduling() {
    // 접속이 오래 끊긴 사람은(재연결 유예 시간을 넘겼다면) 여기서 실제로 정리한다.
    // 방이 종료됐다면(호스트가 오래 끊긴 경우) 더 진행하지 않는다.
    if (this._reapLongDisconnectedHumans()) return;

    const humanWasDealt = this._wasAnyHumanDealtThisHand();

    if (!humanWasDealt) {
      // 이번 핸드에 참여한 사람이 없는 경우(예: AI끼리만 진행된 핸드)는 예전처럼 결과만 짧게 보여주고 자동 진행
      this._scheduleNextHand(this.config.interHandDelayMs);
      return;
    }

    // 다음 핸드 준비 확인은 "지금 연결되어 있는" 사람 기준으로만 기다린다.
    // 접속이 끊긴 사람 때문에 매 핸드 20초씩 기다리는 일이 없도록 하기 위함
    // (그 사람은 DISCONNECT_LEAVE_MS 이상 지속되면 위에서 정리된다).
    const humanSeats = this._connectedHumanSeats();
    if (humanSeats.length === 0) {
      this._scheduleNextHand(this.config.interHandDelayMs);
      return;
    }

    // 리바인 결정을 기다리는 동안 이미 전원이 "다음 핸드 준비"를 눌러뒀을 수도 있으므로,
    // 여기서 바로 확인해서 그렇다면 대기 화면을 띄우지 않고 곧장 다음 핸드로 넘어간다.
    if (humanSeats.every((idx) => this.readyForNext.has(idx))) {
      this._scheduleNextHand(0);
      return;
    }

    clearTimeout(this._handTimer);
    this._awaitingConfirmInfo = { humanSeats };
    this.emit('awaitNextHand', { humanSeats, readySeats: [...this.readyForNext] });
    clearTimeout(this._nextHandFallbackTimer);
    // 응답 없는(자리 비움) 플레이어 때문에 게임이 영원히 멈추지 않도록 하는 안전장치
    this._nextHandFallbackTimer = setTimeout(() => this._playNextHand(), 20000);
  }

  handleReadyForNextHand(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return;
    if (this.status !== 'in_progress') return;
    // 리바인 결정이 아직 안 끝났어도 "다음 핸드 준비" 클릭 자체는 기록해둔다.
    // (예전에는 이 시점에 pendingRebuy가 남아있으면 클릭을 통째로 무시해 버려서, 상대가
    //  리바인을 고민하는 동안 미리 눌러둔 쪽의 클릭이 없었던 일이 되는 버그가 있었다.
    //  그 결과 나중에 다음 핸드로 못 넘어가고 20초 안전장치가 발동할 때까지 멈춰 있었다.)
    this.readyForNext.add(seatIdx);
    this.emit('readyStateChanged', { readySeats: [...this.readyForNext] });
    if (this.pendingRebuy.size > 0) return; // 리바인 결정이 끝나면 _afterHandEndScheduling에서 이어서 확인함

    const humanSeats = this._connectedHumanSeats();
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
    // 호스트든 게스트든, 리바인을 하지 않으면 그 좌석만 퇴장하고 게임은 계속 진행된다.
    // (호스트의 관리 권한(this.hostId)은 좌석 점유 여부와 무관하므로, 호스트가 나가도
    // 방을 닫거나 설정을 바꾸는 권한 체크에는 영향이 없다.)
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

  // 파산해서 비활성화(sitting-out)된 AI 좌석을, 사람이 직접 클릭해 리바인시킬지 결정하게 하는 메서드.
  // AI는 더 이상 자동으로 리바인되지 않으므로, 이 메서드가 유일한 리바인 경로다.
  // playerId는 이 방에 앉아있는 사람이면 누구든(호스트/게스트 모두) 결정할 수 있다.
  handleAiRebuyDecision(playerId, seatIndex, accept) {
    if (this.status !== 'in_progress') throw new Error('게임 진행 중에만 가능합니다');
    if (this.seatByPlayer[playerId] == null) throw new Error('참가자를 찾을 수 없습니다');
    const seat = this.engine.seats[seatIndex];
    if (!seat || seat.type !== 'ai') throw new Error('AI 좌석이 아닙니다');
    if (seat.stack > 0 || !seat.isSittingOut) throw new Error('리바인이 필요한 상태가 아닙니다');

    if (!accept) return { seatIndex, accepted: false };

    const used = this.rebuyCounts[seatIndex] || 0;
    if (used >= this.config.maxRebuys) throw new Error('이 AI는 더 이상 리바인할 수 없습니다(최대 리바인 횟수 도달)');

    // 리바인된 스택 값은 여기서 미리 붙잡아둔다: 아래에서 다음 핸드가 곧바로(동기적으로) 재개될
    // 수 있고, 그러면 블라인드 포스팅으로 seat.stack이 바로 줄어들어 "방금 리바인된 금액"과
    // 달라져 버리기 때문에, 리바인 이벤트/반환값은 항상 실제로 지급된 금액을 그대로 보여줘야 한다.
    const newStack = this.config.rebuyAmount;
    this.rebuyCounts[seatIndex] = used + 1;
    seat.stack = newStack;
    seat.isSittingOut = false;
    this.emit('aiRebuy', { seatIndex, stack: newStack, rebuysUsed: this.rebuyCounts[seatIndex] });
    this._broadcastState();

    if (this._awaitingAiRebuy) {
      this._awaitingAiRebuy = false;
      this._playNextHand();
    }
    return { seatIndex, accepted: true, stack: newStack };
  }

  // 파산해서 비활성화된 AI 좌석을, 리바인시키지도 않고 "닫기"로 결정을 미루지도 않고
  // 아예 그 자리에서 영구히 내보낸다(좌석 자체가 사라짐). maxRebuys 초과로 자동 제거되는
  // 경로(_onHandEnd)와 동일하게 좌석을 완전히 비운다는 점은 같지만, 이건 아직 리바인 여지가
  // 남아있는 AI를 사람이 스스로 원해서 내보내는 경우다.
  handleAiRemoveDecision(playerId, seatIndex) {
    if (this.status !== 'in_progress') throw new Error('게임 진행 중에만 가능합니다');
    if (this.seatByPlayer[playerId] == null) throw new Error('참가자를 찾을 수 없습니다');
    const seat = this.engine.seats[seatIndex];
    if (!seat || seat.type !== 'ai') throw new Error('AI 좌석이 아닙니다');
    if (seat.stack > 0 || !seat.isSittingOut) throw new Error('내보낼 수 있는 상태가 아닙니다');

    this.engine.removeSeat(seatIndex);
    delete this.rebuyCounts[seatIndex];
    this.emit('rebuyResult', { seatIndex, accepted: false, reason: 'removedByHost' });
    this._broadcastState();

    if (this._awaitingAiRebuy) {
      this._awaitingAiRebuy = false;
      this._playNextHand();
    }
    return { seatIndex, removed: true };
  }

  _closeRoom(reason) {
    this.status = 'closed';
    clearTimeout(this._handTimer);
    clearTimeout(this._disconnectGuardTimer);
    clearTimeout(this._aiActionTimer);
    clearTimeout(this._nextHandFallbackTimer);
    clearTimeout(this._boardRevealTimer);
    this._aiLoopActive = false;
    this._awaitingAiRebuy = false;
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

  // boardOverride: 올인 쇼다운 카드를 한 장씩 순서대로 공개하는 동안, 실제 엔진은 이미 최종
  // 상태(전체 보드)까지 가 있지만 클라이언트에는 그중 일부만 보여주기 위한 용도.
  getPublicState(forPlayerId = null, boardOverride = null) {
    const forSeat = forPlayerId != null ? this.seatByPlayer[forPlayerId] : null;
    const engineState = this.engine.getPublicState(forSeat);
    // 각 좌석에 (인간/AI 공통으로) 지금까지 사용한 리바인 횟수를 함께 내려준다.
    // AI 리바인 확인 팝업 등에서 "N/M회 사용" 표시를 하려면 클라이언트가 이 값을 알아야 한다.
    if (engineState.seats) {
      engineState.seats = engineState.seats.map((s) => (s ? { ...s, rebuysUsed: this.rebuyCounts[s.seatIndex] || 0 } : null));
    }
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
      ...engineState,
    };
    if (boardOverride) base.board = boardOverride;
    if (forSeat != null && this.engine.actingSeat === forSeat) {
      base.legalActions = this.engine.getLegalActions(forSeat);
    }
    return base;
  }

  // 재접속한 소켓에게, 접속이 끊긴 사이에 놓쳤을 수 있는 "한 번뿐인" 이벤트를 다시 보내주기 위한
  // 정보를 계산한다. 모바일에서 화면 잠금/백그라운드 전환 등으로 소켓이 잠깐 끊겼다가 재연결되면,
  // 일반 'state' 브로드캐스트만으로는 결과 모달/리바인 확인/다음 핸드 대기 UI를 복구할 수 없어서
  // 게임이 멈춘 것처럼 보이는 문제가 있었다. rejoinRoom 처리 시 이 값을 함께 재전송한다.
  getReconnectExtras(playerId) {
    const seatIdx = this.seatByPlayer[playerId];
    if (seatIdx == null) return null;
    const extras = {};

    if (this._lastHandResult && this.status === 'in_progress') {
      extras.handResult = this._lastHandResult;
    }
    if (this.pendingRebuy.has(seatIdx)) {
      extras.rebuyRequired = {
        seatIndex: seatIdx,
        playerId,
        rebuysUsed: this.rebuyCounts[seatIdx] || 0,
        maxRebuys: this.config.maxRebuys,
      };
    } else if (
      this._awaitingConfirmInfo &&
      this._awaitingConfirmInfo.humanSeats.includes(seatIdx) &&
      !this.readyForNext.has(seatIdx)
    ) {
      extras.awaitNextHand = { humanSeats: this._awaitingConfirmInfo.humanSeats, readySeats: [...this.readyForNext] };
    }
    return extras;
  }
}

module.exports = { TableManager, generateRoomCode };
