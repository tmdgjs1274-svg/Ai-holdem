'use strict';

const assert = require('assert');
const { classifyBoardTexture } = require('../src/ai/BoardTexture');
const { cardFromString } = require('../src/game/Deck');

function cards(strs) {
  return strs.map(cardFromString);
}

function run() {
  let n = 0;
  const check = (label, fn) => {
    fn();
    n++;
    console.log(`  ok - ${label}`);
  };

  check('보드가 3장 미만이면 모두 기본값(웻니스 0)', () => {
    const t = classifyBoardTexture(cards(['As', 'Kd']));
    assert.strictEqual(t.wetness, 0);
    assert.strictEqual(t.paired, false);
  });

  check('모노톤 보드(전부 같은 무늬)는 monotone=true, twoTone=false, 웻니스가 높음', () => {
    const t = classifyBoardTexture(cards(['2s', '7s', 'Js']));
    assert.strictEqual(t.monotone, true);
    assert.strictEqual(t.twoTone, false);
    assert.ok(t.wetness >= 0.4, 'monotone 보드는 웻니스가 충분히 높아야 함');
  });

  check('페어보드는 paired=true이고 커넥티드로는 취급하지 않음', () => {
    const t = classifyBoardTexture(cards(['7s', '7h', '2c']));
    assert.strictEqual(t.paired, true);
    assert.strictEqual(t.connected, false);
  });

  check('트리플 보드는 trips=true', () => {
    const t = classifyBoardTexture(cards(['7s', '7h', '7c']));
    assert.strictEqual(t.trips, true);
    assert.strictEqual(t.paired, true);
  });

  check('랭크가 좁게 몰린 무페어 레인보우 보드는 connected=true', () => {
    const t = classifyBoardTexture(cards(['7s', '8h', '9c']));
    assert.strictEqual(t.connected, true);
  });

  check('아주 드라이한 보드(무페어, 레인보우, 랭크 넓게 흩어짐)는 웻니스가 0에 가까움', () => {
    const t = classifyBoardTexture(cards(['2s', '9h', 'Kc']));
    assert.strictEqual(t.paired, false);
    assert.strictEqual(t.monotone, false);
    assert.strictEqual(t.connected, false);
    assert.ok(t.wetness < 0.2, `드라이 보드의 웻니스는 낮아야 함 (실제: ${t.wetness})`);
  });

  check('모노톤+커넥티드처럼 여러 요소가 겹치면 레인보우 드라이 보드보다 웻니스가 높음', () => {
    const dry = classifyBoardTexture(cards(['2s', '9h', 'Kc']));
    const wet = classifyBoardTexture(cards(['7s', '8s', '9s']));
    assert.ok(wet.wetness > dry.wetness);
  });

  console.log(`BoardTexture: ${n}개 테스트 통과`);
}

module.exports = { run };
