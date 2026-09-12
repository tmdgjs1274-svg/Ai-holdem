'use strict';

const assert = require('assert');
const { BlindStructure, generateDefaultStructure } = require('../src/game/BlindStructure');

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('기본 블라인드 구조: BB 앤티 비활성화 시 앤티 없음, 레벨업마다 스몰블라인드 2배', () => {
    const levels = generateDefaultStructure(100, 200, 6, false);
    assert.strictEqual(levels.length, 6);
    for (const lvl of levels) {
      assert.strictEqual(lvl.ante, 0, `앤티는 항상 0이어야 함 (level ${lvl.level})`);
    }
    assert.strictEqual(levels[0].sb, 100);
    assert.strictEqual(levels[0].bb, 200);
    assert.strictEqual(levels[1].sb, 200);
    assert.strictEqual(levels[1].bb, 400);
    assert.strictEqual(levels[2].sb, 400);
    assert.strictEqual(levels[2].bb, 800);
    assert.strictEqual(levels[3].sb, 800);
  });

  check('커스텀 시작 블라인드 비율도 유지하며 2배씩 상승', () => {
    const levels = generateDefaultStructure(50, 150, 3, false); // bb = 3*sb 비율
    assert.strictEqual(levels[0].sb, 50);
    assert.strictEqual(levels[0].bb, 150);
    assert.strictEqual(levels[1].sb, 100);
    assert.strictEqual(levels[1].bb, 300);
  });

  check('BB 앤티 활성화(기본값)면 각 레벨의 앤티 = 그 레벨의 bb', () => {
    const levels = generateDefaultStructure(100, 200, 4); // bbAnte 기본값 true
    for (const lvl of levels) {
      assert.strictEqual(lvl.ante, lvl.bb, `앤티는 bb와 같아야 함 (level ${lvl.level})`);
    }
  });

  check('BlindStructure.getCurrent()는 마지막 레벨 이후 값을 유지(레벨 승급 없음, 0=고정)', () => {
    const bs = new BlindStructure({ startSb: 100, startBb: 200, levelDurationMinutes: 0 });
    const cur = bs.getCurrent();
    assert.strictEqual(cur.sb, 100);
    assert.strictEqual(cur.ante, 200, '기본값은 BB 앤티 사용이므로 ante=bb');
  });

  check('bbAnte: false로 생성하면 앤티가 전부 0', () => {
    const bs = new BlindStructure({ startSb: 100, startBb: 200, levelDurationMinutes: 0, bbAnte: false });
    assert.strictEqual(bs.getCurrent().ante, 0);
  });

  check('levelDurationMinutes는 모든 레벨에 공통으로 적용되어 시간에 따라 레벨이 올라감', () => {
    const bs = new BlindStructure({ startSb: 100, startBb: 200, levelDurationMinutes: 10 });
    const start = 1_000_000;
    bs.start(start);
    assert.strictEqual(bs.currentLevelIndex(start), 0);
    assert.strictEqual(bs.currentLevelIndex(start + 9 * 60000), 0); // 9분: 아직 레벨1
    assert.strictEqual(bs.currentLevelIndex(start + 10 * 60000), 1); // 10분: 레벨2
    assert.strictEqual(bs.currentLevelIndex(start + 25 * 60000), 2); // 25분: 레벨3
    const cur = bs.getCurrent(start + 25 * 60000);
    assert.strictEqual(cur.sb, 400); // 레벨3 = 100 * 2^2
  });

  console.log(`BlindStructure: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
