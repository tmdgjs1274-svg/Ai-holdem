'use strict';

// 데일리 게임처럼 시간 경과에 따라 자동으로 올라가는 블라인드 구조.
// levels: [{ level, sb, bb, ante }]. 마지막 레벨 이후로는 마지막 레벨 값 유지.

function generateDefaultStructure(startSb = 100, startBb = 200, count = 18) {
  const levels = [];
  const ratio = startBb / startSb;
  let sb = startSb;
  for (let i = 1; i <= count; i++) {
    // 앤티 없음, 레벨업마다 스몰블라인드 기준 2배씩 상승
    levels.push({ level: i, sb, bb: Math.round(sb * ratio), ante: 0 });
    sb *= 2;
  }
  return levels;
}

class BlindStructure {
  /**
   * @param {object} opts
   * @param {Array} [opts.levels] 커스텀 레벨 배열. 미지정시 기본 구조 자동 생성
   * @param {number} [opts.levelDurationMinutes] 레벨 지속 시간(분). 0 또는 null이면 고정 블라인드(레벨업 없음)
   * @param {number} [opts.startSb]
   * @param {number} [opts.startBb]
   */
  constructor({ levels, levelDurationMinutes = 15, startSb = 100, startBb = 200 } = {}) {
    this.levels = levels && levels.length ? levels : generateDefaultStructure(startSb, startBb);
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
