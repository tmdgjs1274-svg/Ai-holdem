'use strict';

// 고정 블라인드 프리셋 (사용자 제공 이미지 기준). 레벨마다 지속시간이 다르다.
// ante는 "BB 앤티" 방식 기준값으로, bbAnte 옵션이 false면 0으로 취급한다.
const DEFAULT_LEVEL_TABLE = [
  { level: 1, sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
  { level: 2, sb: 200, bb: 400, ante: 0, durationMinutes: 7 },
  { level: 3, sb: 300, bb: 600, ante: 0, durationMinutes: 7 },
  { level: 4, sb: 500, bb: 1000, ante: 0, durationMinutes: 7 },
  { level: 5, sb: 1000, bb: 2000, ante: 2000, durationMinutes: 10 },
  { level: 6, sb: 2000, bb: 4000, ante: 4000, durationMinutes: 10 },
  { level: 7, sb: 3000, bb: 6000, ante: 6000, durationMinutes: 10 },
  { level: 8, sb: 4000, bb: 8000, ante: 8000, durationMinutes: 10 },
  { level: 9, sb: 5000, bb: 10000, ante: 10000, durationMinutes: 10 },
  { level: 10, sb: 6000, bb: 12000, ante: 12000, durationMinutes: 5 },
  { level: 11, sb: 8000, bb: 16000, ante: 16000, durationMinutes: 5 },
  { level: 12, sb: 10000, bb: 20000, ante: 20000, durationMinutes: 5 },
];

class BlindStructure {
  /**
   * @param {boolean} bbAnte - true(기본값)면 프리셋의 앤티(BB 앤티 방식)를 그대로 사용,
   *   false면 모든 레벨의 앤티를 0으로 취급한다.
   * @param {Array} levels - 테스트/커스텀용으로 레벨 테이블을 직접 주입할 수 있음(옵션).
   */
  constructor({ bbAnte = true, levels } = {}) {
    this.bbAnte = bbAnte !== false;
    const base = levels && levels.length ? levels : DEFAULT_LEVEL_TABLE;
    this.levels = base.map((lv) => ({
      ...lv,
      ante: this.bbAnte ? lv.ante : 0,
    }));
    this.startedAt = null;
  }

  start(now = Date.now()) {
    this.startedAt = now;
  }

  isEscalating() {
    return this.levels.length > 1;
  }

  /**
   * 각 레벨의 누적 시작 시각(startedAt 기준 경과 분)을 계산해 현재 몇 번째 레벨인지 반환.
   * 레벨마다 durationMinutes가 다를 수 있으므로 누적합으로 계산한다.
   */
  currentLevelIndex(now = Date.now()) {
    if (this.startedAt == null) return 0;
    const elapsedMin = (now - this.startedAt) / 60000;
    let acc = 0;
    for (let i = 0; i < this.levels.length; i++) {
      const dur = this.levels[i].durationMinutes;
      // 마지막 레벨이거나 duration이 없으면(무제한) 여기서 머무름
      if (i === this.levels.length - 1 || !dur) return i;
      acc += dur;
      if (elapsedMin < acc) return i;
    }
    return this.levels.length - 1;
  }

  getCurrent(now = Date.now()) {
    const idx = this.currentLevelIndex(now);
    const level = this.levels[idx];
    let msRemaining = null;
    if (this.startedAt != null && idx < this.levels.length - 1 && level.durationMinutes) {
      // idx 레벨이 시작된 누적 경과 시간(분) 계산
      let accBeforeThis = 0;
      for (let i = 0; i < idx; i++) accBeforeThis += this.levels[i].durationMinutes || 0;
      const levelStartMs = this.startedAt + accBeforeThis * 60000;
      const levelMs = level.durationMinutes * 60000;
      msRemaining = Math.max(0, levelStartMs + levelMs - now);
    }
    return { ...level, msRemaining, isFinalLevel: idx === this.levels.length - 1 };
  }
}

module.exports = { BlindStructure, DEFAULT_LEVEL_TABLE };
