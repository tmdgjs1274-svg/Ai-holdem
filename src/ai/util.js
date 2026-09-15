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

// aiSkillLevel(0~100)과 무관하게 고정된 확률로 섞여 있던 "사람 같은 잡버릇"들
// (가끔 림프, 가끔 3벳 블러프, 근거 약한 브러프캐치 콜 등)에 적용하는 배율.
// - skill===75(기존 기본값)일 때 1을 반환해, 그동안 사용자 피드백으로 튜닝해 온
//   기본 동작(예: "블러프가 너무 많다"는 피드백을 반영해 낮춘 수치들)을 그대로 보존한다.
// - skill이 100에 가까울수록 0으로 수렴해, "실력 100%인데 말도 안 되는 림프/도박성
//   콜을 한다"는 문제를 없앤다(100이면 완전히 0 - 해당 잡버릇이 전혀 나오지 않음).
// - skill이 75보다 낮을수록 오히려 배율이 커져서(최대 3배), 실력이 낮은 AI는 지금보다도
//   더 자주 이런 허술한 플레이를 하는 쪽으로 자연스럽게 이어진다.
function quirkFactor(skill) {
  const s = Math.max(0, Math.min(100, skill));
  return Math.max(0, Math.min(3, (100 - s) / 25));
}

// 예전에는 "AI 실수 빈도"(aiMistakeRate)라는 별도 축으로, 실력(skillLevel)과 무관하게 드물게
// "확 틀리는" 큰 실수(틸트/순간 방심)를 섞었다. 그런데 실력을 100%로 올려도 이 별도 축이
// 남아있는 한 여전히 가끔 이상한 플레이가 나올 수 있어 혼란스럽고("실력 100%인데 왜?"), 두
// 슬라이더가 비슷한 역할을 하는 것처럼 보여 UI도 복잡했다. 그래서 이제는 이 "드문 큰 실수"도
// skillLevel 하나에서 유도한다 - skillLevel=100이면 정확히 0(완전히 사라짐), 낮을수록 커진다.
function bigBlunderChance(skill) {
  const s = Math.max(0, Math.min(100, skill));
  return ((100 - s) / 100) * 0.15; // skill=0: 15%, skill=50: 7.5%, skill=100: 0%
}

module.exports = { roundRaiseTo, quirkFactor, bigBlunderChance };
