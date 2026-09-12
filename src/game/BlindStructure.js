'use strict';

// 기존 방식으로 되돌린 블라인드 구조: 레벨마다 스몰블라인드 기준 2배씩 상승하고,
// 모든 레벨의 지속시간은 공통(levelDurationMinutes)으로 동일하게 적용한다(레벨별 개별 시간 없음).
// bbAnte가 true면 "BB 앤티" 방식(버튼 한 명이 그 레벨의 빅블라인드와 동일한 금액을 혼자 냄)으로
// 각 레벨의 ante가 그 레벨의 bb와 같은 값으로 채워지고, false면 앤티 없이 0으로 유지된다.
function generateDefaultStructure(startSb = 100, startBb = 200, count = 18, bbAnte = true) {
  const levels = [];
  const ratio = startBb / startSb;
  let sb = startSb;
  for (let i = 1; i <= count; i++) {
    const bb = Math.round(sb * ratio);
    levels.push({ level: i, sb, bb, ante: bbAnte ? bb : 0 });
    sb *= 2;
  }
  return levels;
}

class BlindStructure {
  /**
   * @param {Array} [levels] - 직접 레벨 테이블을 주입(옵션). 없으면 startSb/startBb로 기본 생성.
   * @param {number} [levelDurationMinutes] - 모든 레벨에 공통으로 적용되는 지속시간(분). 0이면 블라인드 고정(승급 없음).
   * @param {number} [startSb] - 1레벨 스몰블라인드. 기본 100
   * @param {number} [startBb] - 1레벨 빅블라인드. 기본 200
   * @param {boolean} [bbAnte] - true(기본값)면 각 레벨의 앤티를 그 레벨의 bb와 동일하게 채움(BB 앤티 방식), false면 앤티 없음
   */
  constructor({ levels, levelDurationMinutes = 15, startSb = 100, startBb = 200, bbAnte = true } = {}) {
    this.bbAnte = bbAnte !== false;
    this.levels = levels && levels.length ? levels : generateDefaultStructure(startSb, startBb, 18, this.bbAnte);
    this.levelDurationMinutes = levelDurationMinutes;
    this.startedAt = null;
  }

  start(now = Date.now()) {
    this.startedAt = now;
  }

  isEscalating() {
    return !!this.levelDurationMinutes && this.levelDurationMinutes > 0;
  }

  currentLevelIndex(now = Date.now()) {
    if (!this.isEscalating() || this.startedAt == null) return 0;
    const elapsedMin = (now - this.startedAt) / 60000;
    const idx = Math.floor(elapsedMin / this.levelDurationMinutes);
    return Math.min(idx, this.levels.length - 1);
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

module.exports = { BlindStructure, generateDefaultStructure };
