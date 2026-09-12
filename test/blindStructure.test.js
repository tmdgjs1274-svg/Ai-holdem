'use strict';

const assert = require('assert');
const { BlindStructure, generateDefaultLevels, normalizeLevels } = require('../src/game/BlindStructure');

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('기본 12단계 표: 사용자가 준 실제 홈게임 블라인드 액수와 정확히 일치', () => {
    const levels = generateDefaultLevels(false);
    const expectedSb = [100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000];
    assert.strictEqual(levels.length, 12);
    expectedSb.forEach((sb, i) => {
      assert.strictEqual(levels[i].sb, sb, `레벨 ${i + 1} sb 불일치`);
      assert.strictEqual(levels[i].bb, sb * 2, `레벨 ${i + 1} bb 불일치`);
      assert.strictEqual(levels[i].ante, 0, 'bbAnte=false면 앤티가 전부 0이어야 함');
    });
  });

  check('기본 12단계 표: bbAnte=true(기본값)면 모든 레벨 앤티 = bb', () => {
    const levels = generateDefaultLevels(true);
    for (const lv of levels) assert.strictEqual(lv.ante, lv.bb);
  });

  check('normalizeLevels: 레벨 번호를 1부터 다시 매기고 숫자를 안전하게 정리함', () => {
    const levels = normalizeLevels([
      { sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
      { sb: 50, bb: 200, ante: 10, durationMinutes: 0.4 }, // bb가 sb보다 작지 않도록, duration 최소 1분 보정
    ]);
    assert.strictEqual(levels[0].level, 1);
    assert.strictEqual(levels[1].level, 2);
    assert.strictEqual(levels[1].durationMinutes, 1, 'duration은 최소 1분으로 보정되어야 함');
  });

  check('normalizeLevels: 휴식(isBreak) 레벨은 sb/bb가 없고 duration만 가짐', () => {
    const levels = normalizeLevels([
      { sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
      { isBreak: true, durationMinutes: 5 },
    ]);
    assert.strictEqual(levels[1].isBreak, true);
    assert.strictEqual(levels[1].sb, null);
    assert.strictEqual(levels[1].bb, null);
    assert.strictEqual(levels[1].durationMinutes, 5);
  });

  check('레벨마다 서로 다른 지속시간을 커스텀해도 누적 시간 기준으로 정확히 승급함', () => {
    const bs = new BlindStructure({
      levels: [
        { sb: 100, bb: 200, ante: 0, durationMinutes: 7 },
        { sb: 200, bb: 400, ante: 0, durationMinutes: 10 },
        { sb: 300, bb: 600, ante: 0, durationMinutes: 3 },
      ],
    });
    const start = 1_000_000;
    bs.start(start);
    assert.strictEqual(bs.currentLevelIndex(start), 0);
    assert.strictEqual(bs.currentLevelIndex(start + 6 * 60000), 0, '6분: 아직 레벨1(7분)');
    assert.strictEqual(bs.currentLevelIndex(start + 7 * 60000), 1, '7분: 레벨2로 승급');
    assert.strictEqual(bs.currentLevelIndex(start + 16 * 60000), 1, '16분: 7+10=17분 전이라 아직 레벨2');
    assert.strictEqual(bs.currentLevelIndex(start + 17 * 60000), 2, '17분: 레벨3(마지막)으로 승급');
    // 마지막 레벨은 그 자체 duration(3분)이 지나도 계속 마지막 레벨에 머문다
    assert.strictEqual(bs.currentLevelIndex(start + 100 * 60000), 2, '마지막 레벨은 시간이 아무리 지나도 유지됨');
    assert.strictEqual(bs.getCurrent(start + 100 * 60000).isFinalLevel, true);
  });

  check('휴식(브레이크) 레벨은 직전 실제 레벨의 블라인드를 그대로 이어받아 적용됨', () => {
    const bs = new BlindStructure({
      levels: [
        { sb: 100, bb: 200, ante: 50, durationMinutes: 5 },
        { isBreak: true, durationMinutes: 5 },
        { sb: 300, bb: 600, ante: 0, durationMinutes: 5 },
      ],
    });
    const start = 1_000_000;
    bs.start(start);
    // 5~10분 사이는 휴식 구간 -> 실제 적용 블라인드는 직전 레벨(100/200, 앤티50) 그대로
    const duringBreak = bs.getCurrent(start + 7 * 60000);
    assert.strictEqual(duringBreak.isBreak, true);
    assert.strictEqual(duringBreak.sb, 100, '휴식 중에도 실제 적용 블라인드는 직전 레벨 값을 유지');
    assert.strictEqual(duringBreak.bb, 200);
    assert.strictEqual(duringBreak.ante, 50);
    // 10분 이후에는 3번째(진짜) 레벨로 승급
    const afterBreak = bs.getCurrent(start + 11 * 60000);
    assert.strictEqual(afterBreak.isBreak, false);
    assert.strictEqual(afterBreak.sb, 300);
    assert.strictEqual(afterBreak.bb, 600);
  });

  check('레벨이 1개뿐이면 승급 없이 계속 고정됨', () => {
    const bs = new BlindStructure({ levels: [{ sb: 100, bb: 200, ante: 0, durationMinutes: 5 }] });
    bs.start(1_000_000);
    assert.strictEqual(bs.currentLevelIndex(1_000_000 + 999 * 60000), 0);
  });

  check('replaceLevels로 구조를 통째로 교체하면 레벨1부터 다시 시작함', () => {
    const bs = new BlindStructure({
      levels: [
        { sb: 100, bb: 200, ante: 0, durationMinutes: 5 },
        { sb: 200, bb: 400, ante: 0, durationMinutes: 5 },
      ],
    });
    bs.start(1_000_000);
    assert.strictEqual(bs.currentLevelIndex(1_000_000 + 6 * 60000), 1);
    bs.replaceLevels([{ sb: 50, bb: 100, ante: 0, durationMinutes: 5 }]);
    assert.strictEqual(bs.getCurrent(1_000_000 + 6 * 60000).sb, 50);
  });

  console.log(`BlindStructure: ${n}개 테스트 통과`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
