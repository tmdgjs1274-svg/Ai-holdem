'use strict';

// 블라인드 구조를 레벨 단위로 완전히 커스텀할 수 있게 관리한다. 각 레벨은
// { sb, bb, ante, durationMinutes, isBreak } 형태이며, 호스트가 로비에서 레벨을
// 자유롭게 추가/삭제/수정할 수 있다(금액, 시간, 앤티 전부 개별 설정 가능).
// "휴식(브레이크)" 레벨은 블라인드 변경 없이(sb/bb/ante 없음) 그 시간만큼 시계가 흘러가는
// 표시용 구간으로, 실제 게임에는 직전 레벨의 블라인드가 그대로 적용된다(핸드 진행이
// 자동으로 멈추지는 않는다 - 쉬는 시간임을 화면에 표시해줄 뿐).

// 방을 처음 만들 때 쓰이는 기본 12단계 표 (사용자가 제공한 실제 홈게임 블라인드표 기준).
// bbAnte가 true면 모든 레벨의 ante를 그 레벨의 bb와 동일하게 채운다.
function generateDefaultLevels(bbAnte = true, durationMinutes = 5) {
  const sbAmounts = [100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000];
  return sbAmounts.map((sb) => ({
    sb,
    bb: sb * 2,
    ante: bbAnte ? sb * 2 : 0,
    durationMinutes,
    isBreak: false,
  }));
}

// 레벨 배열을 정규화한다: level 번호를 1부터 다시 매기고, 숫자 필드를 안전한 범위로 정리하며,
// 브레이크가 아닌 레벨에 sb/bb가 없으면 기본값을 채운다.
function normalizeLevels(levels) {
  const list = Array.isArray(levels) && levels.length ? levels : generateDefaultLevels();
  return list.map((lv, i) => {
    const isBreak = !!(lv && lv.isBreak);
    const durationMinutes = Math.max(1, Math.round(Number(lv && lv.durationMinutes) || 5));
    if (isBreak) {
      return { level: i + 1, isBreak: true, durationMinutes, sb: null, bb: null, ante: 0 };
    }
    const sb = Math.max(1, Math.round(Number(lv && lv.sb) || 100));
    const bb = Math.max(sb + 1, Math.round(Number(lv && lv.bb) || sb * 2));
    const ante = Math.max(0, Math.round(Number(lv && lv.ante) || 0));
    return { level: i + 1, isBreak: false, durationMinutes, sb, bb, ante };
  });
}

// 브레이크 레벨은 자체 sb/bb/ante가 없으므로, 실제 게임에 적용할 "유효 블라인드"를
// 직전 실제 레벨(브레이크가 아닌 레벨)에서 이어받아 채워준다. 맨 앞이 브레이크인
// 극단적인 경우(정상적으로는 생기지 않아야 함)에는 0으로 둔다.
function withEffectiveBlinds(levels) {
  let lastReal = { sb: 0, bb: 0, ante: 0 };
  return levels.map((lv) => {
    if (!lv.isBreak) {
      lastReal = { sb: lv.sb, bb: lv.bb, ante: lv.ante };
      return { ...lv, effSb: lv.sb, effBb: lv.bb, effAnte: lv.ante };
    }
    return { ...lv, effSb: lastReal.sb, effBb: lastReal.bb, effAnte: lastReal.ante };
  });
}

class BlindStructure {
  /**
   * @param {Array} [levels] - 레벨 배열. 각 항목은 { sb, bb, ante, durationMinutes, isBreak }.
   *   생략하면 기본 12단계 표가 사용된다.
   * @param {boolean} [bbAnte] - 레벨을 생성할 때(레벨을 직접 안 주고 기본표를 쓸 때)만 참고하는
   *   힌트값. 실제 앤티 금액은 각 레벨의 ante 필드가 갖고 있으므로, 레벨을 직접 준 경우 이
   *   값은 무시된다.
   */
  constructor({ levels, bbAnte = true } = {}) {
    this.bbAnte = bbAnte !== false;
    this.levels = withEffectiveBlinds(normalizeLevels(levels && levels.length ? levels : generateDefaultLevels(this.bbAnte)));
    this.startedAt = null;
    // 게임 시작 전(로비)이거나 승급이 없는 상태일 때 "몇 번째 레벨에 머무를지"를 기억해두는 값.
    this.frozenLevelIndex = 0;
  }

  // 호스트가 로비에서 레벨을 추가/삭제/수정한 뒤 구조 전체를 교체할 때 사용한다.
  replaceLevels(levels) {
    this.levels = withEffectiveBlinds(normalizeLevels(levels));
    this.frozenLevelIndex = 0;
  }

  start(now = Date.now()) {
    this.startedAt = now;
  }

  isEscalating() {
    return this.levels.length > 1;
  }

  currentLevelIndex(now = Date.now()) {
    if (this.startedAt == null) {
      return Math.min(this.frozenLevelIndex || 0, this.levels.length - 1);
    }
    if (!this.isEscalating()) return 0;
    let remaining = (now - this.startedAt) / 60000;
    for (let i = 0; i < this.levels.length - 1; i++) {
      const dur = this.levels[i].durationMinutes;
      if (remaining < dur) return i;
      remaining -= dur;
    }
    return this.levels.length - 1;
  }

  // 주어진 시각까지 "이번 레벨 안에서" 얼마나 시간이 지났는지(분). getCurrent()의 남은 시간
  // 계산과, 도중에 구조가 바뀌었을 때 지금 레벨을 유지시키는 계산에 함께 쓰인다.
  _elapsedWithinLevel(idx, now) {
    let elapsedMin = (now - this.startedAt) / 60000;
    for (let i = 0; i < idx; i++) elapsedMin -= this.levels[i].durationMinutes;
    return elapsedMin;
  }

  getCurrent(now = Date.now()) {
    const idx = this.currentLevelIndex(now);
    const level = this.levels[idx];
    let msRemaining = null;
    const isFinalLevel = idx === this.levels.length - 1;
    if (this.startedAt != null && this.isEscalating() && !isFinalLevel) {
      const elapsedWithin = this._elapsedWithinLevel(idx, now);
      msRemaining = Math.max(0, (level.durationMinutes - elapsedWithin) * 60000);
    }
    return {
      ...level,
      sb: level.effSb,
      bb: level.effBb,
      ante: level.effAnte,
      msRemaining,
      isFinalLevel,
    };
  }
}

module.exports = { BlindStructure, generateDefaultLevels, normalizeLevels };
