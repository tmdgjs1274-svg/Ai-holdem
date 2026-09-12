'use strict';

// 사용자가 제공한 실제 홈게임 블라인드표(브레이크 제외)를 그대로 따르는 배율표.
// 100/200을 기준으로 한 배율이며, 매 레벨 정확히 2배씩 오르지 않고
// (100→200→300→500→1000→2000→3000→4000→5000→6000→8000→10000) 실제 표와 동일하게 상승한다.
const SB_MULTIPLIERS = [1, 2, 3, 5, 10, 20, 30, 40, 50, 60, 80, 100];

// startSb/startBb를 기준으로 위 배율표를 그대로 적용해 레벨을 생성한다.
// 모든 레벨의 지속시간은 공통(levelDurationMinutes)으로 동일하게 적용한다(레벨별 개별 시간 없음).
// bbAnte가 true면 "BB 앤티" 방식(빅블라인드 좌석 한 명이 그 레벨의 빅블라인드와 동일한 금액을 추가로 혼자 냄)으로
// 각 레벨의 ante가 그 레벨의 bb와 같은 값으로 채워지고, false면 앤티 없이 0으로 유지된다.
function generateDefaultStructure(startSb = 100, startBb = 200, count = SB_MULTIPLIERS.length, bbAnte = true) {
  const levels = [];
  const ratio = startBb / startSb;
  const n = Math.max(1, Math.min(count, SB_MULTIPLIERS.length));
  for (let i = 0; i < n; i++) {
    const sb = Math.round(startSb * SB_MULTIPLIERS[i]);
    const bb = Math.round(sb * ratio);
    levels.push({ level: i + 1, sb, bb, ante: bbAnte ? bb : 0 });
  }
  return levels;
}

class BlindStructure {
  /**
   * @param {Array} [levels] - 직접 레벨 테이블을 주입(옵션). 없으면 startSb/startBb로 기본 생성.
   * @param {number} [levelDurationMinutes] - 모든 레벨에 공통으로 적용되는 지속시간(분). 0이면 블라인드 고정(승급 없음). 기본 5분
   * @param {number} [startSb] - 1레벨 스몰블라인드. 기본 100
   * @param {number} [startBb] - 1레벨 빅블라인드. 기본 200
   * @param {boolean} [bbAnte] - true(기본값)면 각 레벨의 앤티를 그 레벨의 bb와 동일하게 채움(BB 앤티 방식), false면 앤티 없음
   */
  constructor({ levels, levelDurationMinutes = 5, startSb = 100, startBb = 200, bbAnte = true } = {}) {
    this.bbAnte = bbAnte !== false;
    this.levels = levels && levels.length ? levels : generateDefaultStructure(startSb, startBb, SB_MULTIPLIERS.length, this.bbAnte);
    this.levelDurationMinutes = levelDurationMinutes;
    this.startedAt = null;
    // 상승 주기가 0(고정)일 때 "몇 레벨에서 고정할지"를 기억해두는 값. 게임 시작 전에는 항상
    // 0(레벨1)이지만, 게임 도중에 상승 주기를 0으로 바꾸면 지금 레벨에서 그대로 고정되어야
    // 하므로(레벨1로 되돌아가면 안 됨) setLevelDurationMinutes()가 이 값을 갱신한다.
    this.frozenLevelIndex = 0;
  }

  start(now = Date.now()) {
    this.startedAt = now;
  }

  isEscalating() {
    return !!this.levelDurationMinutes && this.levelDurationMinutes > 0;
  }

  currentLevelIndex(now = Date.now()) {
    if (!this.isEscalating() || this.startedAt == null) {
      return Math.min(this.frozenLevelIndex || 0, this.levels.length - 1);
    }
    const elapsedMin = (now - this.startedAt) / 60000;
    const idx = Math.floor(elapsedMin / this.levelDurationMinutes);
    return Math.min(idx, this.levels.length - 1);
  }

  // 게임 진행 중에 상승 주기(레벨당 지속시간)만 바꿀 때 사용한다. 기존 startedAt 기준으로
  // 그대로 새 주기를 나눠버리면 레벨이 갑자기 앞뒤로 튈 수 있으므로(예: 15분 주기로 12분
  // 경과한 상태에서 5분으로 바꾸면 레벨이 2단계나 건너뛰어 버림), 지금 레벨은 그대로 유지한
  // 채 이 순간부터 새 주기로 다시 카운트다운을 시작한 것처럼 startedAt을 재계산한다.
  setLevelDurationMinutes(newDurationMinutes, now = Date.now()) {
    const duration = Math.max(0, Number(newDurationMinutes) || 0);
    if (this.startedAt == null) {
      // 아직 게임이 시작되지 않았다면(로비) 타이머 기준점이 없으므로 값만 바꾸면 충분하다.
      this.levelDurationMinutes = duration;
      return;
    }
    const currentIdx = this.currentLevelIndex(now);
    this.levelDurationMinutes = duration;
    this.frozenLevelIndex = currentIdx;
    if (duration > 0) {
      this.startedAt = now - currentIdx * duration * 60000;
    }
  }

  getCurrent(now = Date.now()) {
    const idx = this.currentLevelIndex(now);
    const level = this.levels[idx];
    let msRemaining = null;
    if (this.isEscalating() && this.startedAt != null && idx < this.levels.length - 1) {
      const levelMs = this.levelDurationMinutes * 60000;
      const elapsed = now - this.startedAt;
      msRemaining = levelMs - (elapsed % levelMs);
    }
    return { ...level, msRemaining, isFinalLevel: idx === this.levels.length - 1 };
  }
}

module.exports = { BlindStructure, generateDefaultStructure, SB_MULTIPLIERS };
