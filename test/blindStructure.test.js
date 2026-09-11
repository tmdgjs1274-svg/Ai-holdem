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

  check('기본 블라인드 구조: 앤티 없음, 레벨업마다 스몰블라인드 2배', () => {
    const levels = generateDefaultStructure(100, 200, 6);
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
    const levels = generateDefaultStructure(50, 150, 3); // bb = 3*sb 비율
    assert.strictEqual(levels[0].sb, 50);
    assert.strictEqual(levels[0].bb, 150);
    assert.strictEqual(levels[1].sb, 100);
    assert.strictEqual(levels[1].bb, 300);
  });

  check('BlindStructure.getCurrent()는 마지막 레벨 이후 값을 유지', () => {
    const bs = new BlindStructure({ startSb: 100, startBb: 200, levelDurationMinutes: 0 });
    const cur = bs.getCurrent();
    assert.strictEqual(cur.sb, 100);
    assert.strictEqual(cur.ante, 0);
  });

  console.log(`BlindStructure: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
