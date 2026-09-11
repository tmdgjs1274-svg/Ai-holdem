'use strict';

// AI의 베팅/레이즈 금액을 보기 좋은 단위(기본 100)로 반올림하면서
// 합법적인 범위(legal.minRaiseTo ~ legal.maxRaiseTo)를 벗어나지 않도록 보정한다.
function roundRaiseTo(rawRaiseTo, legal, unit = 100) {
  let v = Math.round(rawRaiseTo / unit) * unit;
  if (v < legal.minRaiseTo) v = Math.ceil(legal.minRaiseTo / unit) * unit;
  if (v > legal.maxRaiseTo) v = legal.maxRaiseTo;
  if (v < legal.minRaiseTo) v = legal.minRaiseTo; // 올인이 최소레이즈보다 작은 극단적 상황 대비
  return v;
}

module.exports = { roundRaiseTo };
