'use strict';

const EventEmitter = require('events');
const { Shoe, cardToString } = require('./Deck');
const { evaluateBest, compareScore } = require('./HandEvaluator');

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

/**
 * 좌석 간 순환 이동을 돕는 헬퍼.
 * seats: 길이 고정 배열, 빈 좌석은 null
 */
function nextIndex(seats, fromIndex, predicate) {
  const n = seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (seats[idx] && predicate(seats[idx], idx)) return idx;
  }
  return -1;
}

/**
 * 사이드팟 계산. contributions: [{ playerSeat, amount, folded }]
 * 반환: [{ amount, eligibleSeats: [seatIndex,...] }]
 */
function computePots(contributions) {
  const remaining = contributions
    .filter((c) => c.amount > 0)
    .map((c) => ({ ...c }));
  const pots = [];
  while (remaining.some((c) => c.amount > 0)) {
    const positive = remaining.filter((c) => c.amount > 0);
    const minAmt = Math.min(...positive.map((c) => c.amount));
    let potAmount = 0;
    for (const c of positive) {
      potAmount += minAmt;
      c.amount -= minAmt;
    }
    const eligibleSeats = positive.filter((c) => !c.folded).map((c) => c.playerSeat);
    if (eligibleSeats.length > 0) {
      pots.push({ amount: potAmount, eligibleSeats });
    } else if (pots.length > 0) {
      // 이 레이어에 기여한 전원이 폴드 -> 직전 팟에 합산 (발생 빈도 매우 낮은 엣지케이스)
      pots[pots.length - 1].amount += potAmount;
    }
  }
  return pots;
}

class GameEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.maxSeats
   * @param {function} [opts.rng] 0~1 난수 함수 (테스트용 시드 고정 가능)
   */
  constructor({ maxSeats = 9, rng = Math.random } = {}) {
    super();
    this.maxSeats = maxSeats;
    this.rng = rng;
    this.seats = new Array(maxSeats).fill(null); // { seatIndex, playerId, displayName, type, stack, isSittingOut }
    this.buttonIndex = -1;
    this.handNumber = 0;
    this.street = 'idle';
    this.board = [];
    this.pots = [];
    this.smallBlind = 25;
    this.bigBlind = 50;
    this.ante = 0;
    this.hs = null; // hand-scoped state, keyed by seatIndex
    this.lastHandResult = null;
  }

  setBlinds(smallBlind, bigBlind, ante = 0) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.ante = ante;
  }

  seatPlayer(seatIndex, { playerId, displayName, type, stack }) {
    if (this.seats[seatIndex]) throw new Error('이미 앉아있는 좌석입니다');
    this.seats[seatIndex] = { seatIndex, playerId, displayName, type, stack, isSittingOut: false };
  }

  removeSeat(seatIndex) {
    this.seats[seatIndex] = null;
  }

  occupiedSeats() {
    return this.seats.filter(Boolean);
  }

  playersEligibleForHand() {
    return this.seats.filter((s) => s && !s.isSittingOut && s.stack > 0);
  }

  canStartHand() {
    return this.playersEligibleForHand().length >= 2;
  }

  // ---------- 핸드 시작 ----------

  startHand() {
    if (!this.canStartHand()) {
      throw new Error('핸드를 시작하려면 최소 2명의 참가자가 필요합니다');
    }
    this.handNumber += 1;
    this.shoe = new Shoe(this.rng);
    this.board = [];
    this.pots = [];
    this.street = 'preflop';
    this.lastHandResult = null;

    const inHandSeats = [];
    this.hs = {};
    for (const seat of this.seats) {
      if (!seat) continue;
      const playing = !seat.isSittingOut && seat.stack > 0;
      this.hs[seat.seatIndex] = {
        holeCards: [],
        folded: !playing,
        allIn: false,
        committedThisHand: 0,
        committedThisStreet: 0,
        hasActedThisStreet: false,
        inHand: playing,
      };
      if (playing) inHandSeats.push(seat.seatIndex);
    }

    // 버튼 이동: 다음 참여 좌석으로
    if (this.buttonIndex === -1 || !inHandSeats.includes(this.buttonIndex)) {
      this.buttonIndex = inHandSeats[0];
    } else {
      const next = nextIndex(this.seats, this.buttonIndex, (s) => this.hs[s.seatIndex].inHand);
      this.buttonIndex = next;
    }

    const headsUp = inHandSeats.length === 2;
    let sbIndex, bbIndex, firstToActPreflop;
    if (headsUp) {
      // 헤즈업: 버튼 = SB, 먼저 액션도 버튼(SB)이 함
      sbIndex = this.buttonIndex;
      bbIndex = nextIndex(this.seats, this.buttonIndex, (s) => this.hs[s.seatIndex].inHand);
      firstToActPreflop = sbIndex;
    } else {
      sbIndex = nextIndex(this.seats, this.buttonIndex, (s) => this.hs[s.seatIndex].inHand);
      bbIndex = nextIndex(this.seats, sbIndex, (s) => this.hs[s.seatIndex].inHand);
      firstToActPreflop = nextIndex(this.seats, bbIndex, (s) => this.hs[s.seatIndex].inHand);
    }
    this.sbIndex = sbIndex;
    this.bbIndex = bbIndex;

    // 앤티 (설정된 경우 전원)
    if (this.ante > 0) {
      for (const seatIdx of inHandSeats) {
        this._commit(seatIdx, Math.min(this.ante, this.seats[seatIdx].stack));
      }
      // 앤티는 스트리트 커밋에 포함하지 않음 (베팅 라운드 콜금액 계산과 무관하도록 리셋)
      for (const seatIdx of inHandSeats) this.hs[seatIdx].committedThisStreet = 0;
    }

    this._commit(sbIndex, Math.min(this.smallBlind, this.seats[sbIndex].stack));
    this._commit(bbIndex, Math.min(this.bigBlind, this.seats[bbIndex].stack));

    for (const seatIdx of inHandSeats) {
      this.hs[seatIdx].holeCards = this.shoe.drawN(2);
    }

    this.currentBet = Math.max(...inHandSeats.map((i) => this.hs[i].committedThisStreet));
    this.minRaiseIncrement = this.bigBlind;
    this.lastAggressorSeat = bbIndex; // 프리플랍 기준점

    this._resetActedFlags();
    this.actingSeat = this._findNextToAct(firstToActPreflop, true);

    this.emit('handStart', this.getPublicState());
    this._maybeAutoAdvance();
    return this.getPublicState();
  }

  _commit(seatIdx, amount) {
    const seat = this.seats[seatIdx];
    const hs = this.hs[seatIdx];
    const actual = Math.min(amount, seat.stack);
    seat.stack -= actual;
    hs.committedThisHand += actual;
    hs.committedThisStreet += actual;
    if (seat.stack === 0) hs.allIn = true;
    return actual;
  }

  _resetActedFlags() {
    for (const seatIdx of Object.keys(this.hs)) {
      const hs = this.hs[seatIdx];
      if (hs.inHand && !hs.folded && !hs.allIn) hs.hasActedThisStreet = false;
    }
  }

  _activePlayers() {
    // 아직 폴드하지 않고 핸드에 남아있는 좌석 (올인 포함)
    return Object.keys(this.hs)
      .map(Number)
      .filter((i) => this.hs[i].inHand && !this.hs[i].folded);
  }

  _playersToAct() {
    // 액션을 해야 할 수 있는 좌석 (올인 제외)
    return this._activePlayers().filter((i) => !this.hs[i].allIn);
  }

  _findNextToAct(fromIndex, includeFrom) {
    const toAct = new Set(this._playersToAct());
    if (toAct.size === 0) return -1;
    if (includeFrom && toAct.has(fromIndex) && !this.hs[fromIndex].hasActedThisStreet) return fromIndex;
    let idx = fromIndex;
    for (let step = 0; step < this.seats.length; step++) {
      idx = (idx + 1) % this.seats.length;
      if (toAct.has(idx) && (this.hs[idx].committedThisStreet < this.currentBet || !this.hs[idx].hasActedThisStreet)) {
        return idx;
      }
    }
    return -1;
  }

  // ---------- 액션 처리 ----------

  getLegalActions(seatIndex) {
    if (this.actingSeat !== seatIndex) return null;
    const hs = this.hs[seatIndex];
    const seat = this.seats[seatIndex];
    const toCall = this.currentBet - hs.committedThisStreet;
    const canCheck = toCall <= 0;
    const canCall = toCall > 0 && seat.stack > 0;
    const callAmount = Math.min(toCall, seat.stack);
    const minRaiseTo = this.currentBet + this.minRaiseIncrement;
    const maxRaiseTo = hs.committedThisStreet + seat.stack; // 올인
    const canRaise = seat.stack > callAmount; // 콜하고도 남는 칩이 있어야 레이즈 가능
    return {
      canFold: true,
      canCheck,
      canCall,
      callAmount,
      canRaise,
      minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
      maxRaiseTo,
      stack: seat.stack,
    };
  }

  applyAction(seatIndex, actionType, amount = 0) {
    if (this.actingSeat !== seatIndex) {
      throw new Error(`지금은 좌석 ${seatIndex}의 차례가 아닙니다`);
    }
    const legal = this.getLegalActions(seatIndex);
    const seat = this.seats[seatIndex];
    const hs = this.hs[seatIndex];

    let record = { seatIndex, actionType, amount: 0 };

    if (actionType === 'fold') {
      hs.folded = true;
      record.amount = 0;
    } else if (actionType === 'check') {
      if (!legal.canCheck) throw new Error('체크할 수 없는 상황입니다 (콜 필요)');
    } else if (actionType === 'call') {
      const paid = this._commit(seatIndex, legal.callAmount);
      record.amount = paid;
    } else if (actionType === 'bet' || actionType === 'raise') {
      const raiseTo = Math.max(amount, legal.minRaiseTo);
      const cappedRaiseTo = Math.min(raiseTo, legal.maxRaiseTo);
      const toCommit = cappedRaiseTo - hs.committedThisStreet;
      if (toCommit <= (this.currentBet - hs.committedThisStreet)) {
        throw new Error('레이즈 금액이 올바르지 않습니다');
      }
      const increment = cappedRaiseTo - this.currentBet;
      const paid = this._commit(seatIndex, toCommit);
      record.amount = paid;
      if (cappedRaiseTo > this.currentBet) {
        this.currentBet = cappedRaiseTo;
        // 정식 레이즈(최소레이즈 이상)면 minRaiseIncrement 갱신 및 액션 재오픈
        if (increment >= this.minRaiseIncrement) {
          this.minRaiseIncrement = increment;
          this._resetActedFlags();
        }
        this.lastAggressorSeat = seatIndex;
      }
    } else if (actionType === 'allin') {
      const paid = this._commit(seatIndex, seat.stack);
      record.amount = paid;
      const newTotal = hs.committedThisStreet;
      if (newTotal > this.currentBet) {
        const increment = newTotal - this.currentBet;
        this.currentBet = newTotal;
        if (increment >= this.minRaiseIncrement) {
          this.minRaiseIncrement = increment;
          this._resetActedFlags();
        }
        this.lastAggressorSeat = seatIndex;
      }
    } else {
      throw new Error(`알 수 없는 액션: ${actionType}`);
    }

    hs.hasActedThisStreet = true;
    this.emit('action', { ...record, seat: seat.displayName });

    this._advance();
    return this.getPublicState();
  }

  _advance() {
    const active = this._activePlayers();
    if (active.length <= 1) {
      this._endHandByFold(active[0]);
      return;
    }
    const toAct = this._playersToAct();
    const roundDone =
      toAct.length === 0 ||
      toAct.every((i) => this.hs[i].hasActedThisStreet && this.hs[i].committedThisStreet === this.currentBet);

    if (roundDone) {
      this._goToNextStreet();
    } else {
      const startFrom = this.actingSeat;
      this.actingSeat = this._findNextToAct(startFrom, false);
      if (this.actingSeat === -1) this._goToNextStreet();
    }
  }

  _maybeAutoAdvance() {
    // 스타트 직후 모두 올인이라 액션할 사람이 없는 경우 보드를 바로 진행
    if (this.actingSeat === -1 && this.street !== 'showdown' && this.street !== 'idle') {
      const active = this._activePlayers();
      if (active.length <= 1) {
        this._endHandByFold(active[0]);
      } else {
        this._goToNextStreet();
      }
    }
  }

  _goToNextStreet() {
    for (const idx of Object.keys(this.hs)) this.hs[idx].committedThisStreet = 0;
    this.minRaiseIncrement = this.bigBlind;
    this.currentBet = 0;
    this._resetActedFlags();

    const streetIdx = STREETS.indexOf(this.street);
    const active = this._activePlayers();

    if (active.length <= 1) {
      this._endHandByFold(active[0]);
      return;
    }

    if (this.street === 'river') {
      this._goToShowdown();
      return;
    }

    if (this.street === 'preflop') {
      this.board.push(...this.shoe.drawN(3));
      this.street = 'flop';
    } else if (this.street === 'flop') {
      this.board.push(...this.shoe.drawN(1));
      this.street = 'turn';
    } else if (this.street === 'turn') {
      this.board.push(...this.shoe.drawN(1));
      this.street = 'river';
    }

    this.emit('street', { street: this.street, board: this.board.map(cardToString) });

    const toAct = this._playersToAct();
    if (toAct.length <= 1) {
      // 남은 액션 가능자가 1명 이하 (나머지 올인) -> 액션 없이 바로 다음 스트리트로 진행
      this.actingSeat = -1;
      this._maybeAutoAdvance();
      return;
    }

    const firstToAct = nextIndex(this.seats, this.buttonIndex, (s) => this._playersToAct().includes(s.seatIndex));
    this.actingSeat = firstToAct === -1 ? -1 : this._findNextToAct(firstToAct, true);
    if (this.actingSeat === -1) this._maybeAutoAdvance();
  }

  _endHandByFold(winnerSeatIndex) {
    const contributions = Object.keys(this.hs).map((idx) => ({
      playerSeat: Number(idx),
      amount: this.hs[idx].committedThisHand,
      folded: this.hs[idx].folded,
    }));
    const pots = computePots(contributions);
    const winnings = {};
    for (const pot of pots) {
      // 폴드로 끝난 경우 eligibleSeats는 항상 winnerSeatIndex 하나
      for (const s of pot.eligibleSeats) {
        winnings[s] = (winnings[s] || 0) + Math.floor(pot.amount / pot.eligibleSeats.length);
      }
    }
    this._applyWinnings(winnings);
    this.street = 'showdown';
    this.actingSeat = -1;
    this.lastHandResult = {
      type: 'fold',
      board: this.board.map(cardToString),
      winnings,
      showdown: [],
    };
    this.emit('handEnd', this.lastHandResult);
  }

  _goToShowdown() {
    while (this.board.length < 5) {
      this.board.push(...this.shoe.drawN(1));
    }
    const active = this._activePlayers();
    const contributions = Object.keys(this.hs).map((idx) => ({
      playerSeat: Number(idx),
      amount: this.hs[idx].committedThisHand,
      folded: this.hs[idx].folded,
    }));
    const pots = computePots(contributions);

    const bestBySeat = {};
    for (const seatIdx of active) {
      bestBySeat[seatIdx] = evaluateBest([...this.hs[seatIdx].holeCards, ...this.board]);
    }

    const winnings = {};
    const potResults = [];
    for (const pot of pots) {
      let bestScore = null;
      let winners = [];
      for (const seatIdx of pot.eligibleSeats) {
        const score = bestBySeat[seatIdx];
        if (!bestScore || compareScore(score, bestScore) > 0) {
          bestScore = score;
          winners = [seatIdx];
        } else if (compareScore(score, bestScore) === 0) {
          winners.push(seatIdx);
        }
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // 나머지 칩은 버튼 기준으로 가장 먼저인 위너에게
      const orderedWinners = winners.slice().sort((a, b) => {
        const da = (a - this.buttonIndex + this.seats.length) % this.seats.length;
        const db = (b - this.buttonIndex + this.seats.length) % this.seats.length;
        return da - db;
      });
      for (const w of orderedWinners) {
        winnings[w] = (winnings[w] || 0) + share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
      }
      potResults.push({ amount: pot.amount, winners, handName: bestScore.name });
    }

    this._applyWinnings(winnings);
    this.street = 'showdown';
    this.actingSeat = -1;
    this.lastHandResult = {
      type: 'showdown',
      board: this.board.map(cardToString),
      winnings,
      showdown: active.map((seatIdx) => ({
        seatIndex: seatIdx,
        holeCards: this.hs[seatIdx].holeCards.map(cardToString),
        hand: bestBySeat[seatIdx].name,
      })),
      pots: potResults,
    };
    this.emit('handEnd', this.lastHandResult);
  }

  _applyWinnings(winnings) {
    for (const [seatIdx, amount] of Object.entries(winnings)) {
      this.seats[Number(seatIdx)].stack += amount;
    }
  }

  // ---------- 상태 조회 ----------

  activePlayerSeats() {
    return this._activePlayers();
  }

  totalChipsOnTable() {
    return this.occupiedSeats().reduce((sum, s) => sum + s.stack, 0);
  }

  potNow() {
    if (!this.hs) return 0;
    return Object.values(this.hs).reduce((sum, h) => sum + h.committedThisHand, 0);
  }

  /**
   * 버튼 다음(SB) 좌석부터 시계방향으로, 이번 핸드에 참여 중인(폴드 무관) 좌석 인덱스를
   * 버튼 자신까지 순서대로 반환. 예: [SB, BB, UTG, ..., CO, BTN]
   * 헤즈업이면 [BB, BTN(=SB)] 형태가 된다.
   */
  handSeatsInOrder() {
    const order = [];
    if (!this.hs) return order;
    const n = this.seats.length;
    let idx = this.buttonIndex;
    for (let step = 0; step < n; step++) {
      idx = (idx + 1) % n;
      if (this.seats[idx] && this.hs[idx] && this.hs[idx].inHand) {
        order.push(idx);
      }
    }
    return order;
  }

  getPublicState(forSeatIndex = null) {
    return {
      handNumber: this.handNumber,
      street: this.street,
      board: this.board.map(cardToString),
      buttonIndex: this.buttonIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      currentBet: this.currentBet,
      actingSeat: this.actingSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      pot: this.hs
        ? Object.values(this.hs).reduce((sum, h) => sum + h.committedThisHand, 0)
        : 0,
      seats: this.seats.map((s) => {
        if (!s) return null;
        const hs = this.hs && this.hs[s.seatIndex];
        return {
          seatIndex: s.seatIndex,
          playerId: s.playerId,
          displayName: s.displayName,
          type: s.type,
          stack: s.stack,
          isSittingOut: s.isSittingOut,
          folded: hs ? hs.folded : false,
          allIn: hs ? hs.allIn : false,
          committedThisStreet: hs ? hs.committedThisStreet : 0,
          committedThisHand: hs ? hs.committedThisHand : 0,
          holeCards:
            hs && (forSeatIndex === s.seatIndex || this.street === 'showdown')
              ? hs.holeCards.map(cardToString)
              : hs && hs.holeCards.length
              ? ['??', '??']
              : [],
        };
      }),
      lastHandResult: this.lastHandResult,
    };
  }
}

module.exports = { GameEngine, computePots, nextIndex };
