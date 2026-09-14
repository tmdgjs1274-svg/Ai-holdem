'use strict';

/**
 * 테이블(TableManager) 하나당 하나씩 붙어서, 여러 핸드에 걸쳐 각 좌석의 성향을 가볍게
 * 누적 추적하는 경량 통계 모델이다. 완벽한 "이 사람이 누구인지" 추적이 아니라 "지금
 * 이 좌석에서 어떻게 플레이해왔는지"를 근사로 기록한다(좌석에 새 사람/AI가 앉아도 통계가
 * 이어지지만, 이는 실전에서도 "그 자리 사람 성향을 본다"는 수준의 근사로 충분하다).
 *
 * aiSkillLevel이 높은 AI만 이 통계를 참고해 블러프/콜/밸류벳 임계값을 조정한다(익스플로잇).
 * 표본이 너무 적으면(하한 미만) 판단을 보류하고 null을 돌려줘서, 호출부가 기본 전략으로
 * 되돌아가게 한다.
 */
class OpponentModel {
  constructor() {
    this.bySeat = {};
  }

  _stat(seatIndex) {
    if (!this.bySeat[seatIndex]) {
      this.bySeat[seatIndex] = {
        hands: 0,
        vpip: 0,
        pfr: 0,
        facedBet: 0,
        foldedToBet: 0,
        betOrRaise: 0,
        calledOnly: 0,
      };
    }
    return this.bySeat[seatIndex];
  }

  /** 핸드 시작 시, 이번 핸드에 실제로 참여하는 좌석들의 표본 수를 늘린다. */
  recordHandStart(seatIndexes) {
    for (const idx of seatIndexes) this._stat(idx).hands += 1;
  }

  /** GameEngine의 'action' 이벤트(street, actionType, toCallBefore 포함)를 그대로 받아 누적한다. */
  recordAction({ seatIndex, street, actionType, toCallBefore }) {
    if (seatIndex == null) return;
    const s = this._stat(seatIndex);
    const facedBet = (toCallBefore || 0) > 0;

    if (street === 'preflop') {
      // 자발적으로 돈을 더 넣은 경우만 VPIP(체크/폴드는 제외). 블라인드 강제납부는 애초에
      // applyAction을 거치지 않으므로(엔진이 startHand에서 직접 처리) 여기 섞이지 않는다.
      if (actionType === 'call' || actionType === 'raise' || actionType === 'bet' || actionType === 'allin') {
        s.vpip += 1;
      }
      if (actionType === 'raise' || actionType === 'bet' || actionType === 'allin') s.pfr += 1;
    }

    if (facedBet) {
      s.facedBet += 1;
      if (actionType === 'fold') s.foldedToBet += 1;
    }

    if (actionType === 'bet' || actionType === 'raise' || actionType === 'allin') s.betOrRaise += 1;
    else if (actionType === 'call') s.calledOnly += 1;
  }

  /** 0~1. 표본(핸드 수)이 부족하면 null. */
  vpipRate(seatIndex) {
    const s = this.bySeat[seatIndex];
    if (!s || s.hands < 5) return null;
    return s.vpip / s.hands;
  }

  /** 베팅에 직면했을 때 폴드한 비율. 표본(직면 횟수)이 부족하면 null. */
  foldToBetRate(seatIndex) {
    const s = this.bySeat[seatIndex];
    if (!s || s.facedBet < 5) return null;
    return s.foldedToBet / s.facedBet;
  }

  /** 베팅/레이즈 대 콜의 비율(공격성). 표본이 부족하면 null. */
  aggressionRate(seatIndex) {
    const s = this.bySeat[seatIndex];
    const total = s ? s.betOrRaise + s.calledOnly : 0;
    if (!s || total < 5) return null;
    return s.betOrRaise / total;
  }
}

module.exports = { OpponentModel };
