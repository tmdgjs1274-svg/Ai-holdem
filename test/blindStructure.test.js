'use strict';

const assert = require('assert');
const { BlindStructure, DEFAULT_LEVEL_TABLE } = require('../src/game/BlindStructure');

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('기본 프리셋: 12레벨, 이미지 값과 일치 (BB 앤티 사용 시)', () => {
    const bs = new BlindStructure({ bbAnte: true });
    assert.strictEqual(bs.levels.length, 12);
    assert.deepStrictEqual(
      bs.levels.map((l) => [l.sb, l.bb, l.ante, l.durationMinutes]),
      DEFAULT_LEVEL_TABLE.map((l) => [l.sb, l.bb, l.ante, l.durationMinutes])
    );
    // 앞 4레벨은 앤티 없음, 5레벨부터 BB와 동일한 앤티
    assert.strictEqual(bs.levels[0].ante, 0);
    assert.strictEqual(bs.levels[3].ante, 0);
    assert.strictEqual(bs.levels[4].ante, bs.levels[4].bb);
    assert.strictEqual(bs.levels[11].sb, 10000);
    assert.strictEqual(bs.levels[11].bb, 20000);
  });

  check('bbAnte: false면 모든 레벨의 앤티가 0으로 강제됨', () => {
    const bs = new BlindStructure({ bbAnte: false });
    for (const lvl of bs.levels) {
      assert.strictEqual(lvl.ante, 0, `앤티는 0이어야 함 (level ${lvl.level})`);
    }
    // SB/BB 값 자체는 그대로 유지
    assert.strictEqual(bs.levels[4].sb, 1000);
    assert.strictEqual(bs.levels[4].bb, 2000);
  });

  check('시작 전(startedAt=null)에는 항상 레벨1', () => {
    const bs = new BlindStructure({ bbAnte: true });
    const cur = bs.getCurrent();
    assert.strictEqual(cur.level, 1);
    assert.strictEqual(cur.sb, 100);
    assert.strictEqual(cur.bb, 200);
  });

  check('레벨별로 다른 지속시간을 반영해 누적 경과시간으로 레벨 계산', () => {
    const bs = new BlindStructure({ bbAnte: true });
    const start = 1_000_000;
    bs.start(start);
    // 레벨1~4는 7분씩 = 28분. 그 이후 레벨5(10분)
    assert.strictEqual(bs.currentLevelIndex(start), 0);
    assert.strictEqual(bs.currentLevelIndex(start + 6 * 60000), 0); // 6분 경과: 아직 레벨1
    assert.strictEqual(bs.currentLevelIndex(start + 7 * 60000), 1); // 7분 경과: 레벨2 진입
    assert.strictEqual(bs.currentLevelIndex(start + 27 * 60000), 3); // 27분: 레벨4
    assert.strictEqual(bs.currentLevelIndex(start + 28 * 60000), 4); // 28분: 레벨5(10분 구간) 진입
    assert.strictEqual(bs.currentLevelIndex(start + 37 * 60000), 4); // 37분: 아직 레벨5
    assert.strictEqual(bs.currentLevelIndex(start + 38 * 60000), 5); // 38분: 레벨6
  });

  check('getCurrent()는 마지막 레벨 이후에도 마지막 레벨 값을 유지', () => {
    const bs = new BlindStructure({ bbAnte: true });
    bs.start(0);
    const cur = bs.getCurrent(10_000 * 60000); // 아주 먼 미래
    assert.strictEqual(cur.isFinalLevel, true);
    assert.strictEqual(cur.level, 12);
    assert.strictEqual(cur.sb, 10000);
    assert.strictEqual(cur.msRemaining, null);
  });

  check('getCurrent()의 msRemaining은 현재 레벨이 끝나기까지 남은 시간(ms)', () => {
    const bs = new BlindStructure({ bbAnte: true });
    const start = 0;
    bs.start(start);
    const cur = bs.getCurrent(start + 2 * 60000); // 레벨1 시작 2분 경과 (레벨1은 7분)
    assert.strictEqual(cur.level, 1);
    assert.strictEqual(cur.msRemaining, 5 * 60000);
  });

  console.log(`BlindStructure: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
