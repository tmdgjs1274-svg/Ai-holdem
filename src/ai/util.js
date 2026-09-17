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

// 3벳/4벳 블러프, 살짝 못 미치는 손패로 가끔 더 버텨보는 콜처럼 "실수"가 아니라 실제
// 강한 플레이어도 유지하는 "의도된 밸런스(믹스) 전략" 확률에 곱하는 배율. quirkFactor와
// 이름은 비슷해 보이지만 용도가 다르다: quirkFactor는 skill=100에서 정확히 0으로
// 수렴해야 하는 "허술한 실수성" 확률(랜덤 림프 등)에, mixFrequency는 skill=100에서도
// 0이 되면 안 되는 "전략적으로 의도된" 확률(3벳 블러프, 3벳 콜다운 등)에 쓴다.
// 실제 프로들도 타이트한 레인지를 유지하면서도 3벳 블러프나 3벳에 대한 콜다운 빈도를
// 완전히 0으로 만들지 않는다 - 그래야 상대가 AI의 레인지를 쉽게 읽어내지 못한다.
// skill===75(기존 기본값)에서 1을 반환해 기존 튜닝을 보존하고, skill=100에서는 0.5로만
// 줄어든다(완전히 사라지지 않음). skill이 낮을수록 quirkFactor와 같은 기울기로 커진다.
function mixFrequency(skill) {
  const s = Math.max(0, Math.min(100, skill));
  return Math.max(0.5, Math.min(3, 1 + (75 - s) * 0.02));
}

// GTO 폴라라이즈드 벳의 "밸류:블러프 비율" 공식. 베팅 사이즈가 팟의 sizeFrac배일 때, 상대가
// 콜/폴드 중 어느 쪽을 골라도 무차별(indifferent)하도록 만드는 블러프 비율(벳/레이즈 범위 중
// 블러프가 차지해야 할 몫)이다. 사이즈가 클수록(오버벳일수록) 이 비율도 커진다 - "크게 베팅할
// 때는 블러프도 그만큼 더 섞어야 한다"는 솔버의 핵심 성질을 그대로 반영한 것이다.
function gtoBluffRatio(sizeFrac) {
  const s = Math.max(0, sizeFrac);
  return s / (1 + 2 * s);
}

// 최소방어빈도(MDF, Minimum Defense Frequency). 상대가 팟의 sizeFrac배를 베팅했을 때, 내가
// 최소 이 비율만큼은 계속(콜/레이즈)해야 상대가 "아무 패로나 베팅해도 무조건 이득"인 상황을
// 막을 수 있다. sizeFrac이 클수록(오버벳일수록) MDF는 낮아진다 - 오버벳에는 더 자주 폴드해도
// 된다는(반대로 작은 벳에는 훨씬 넓게 방어해야 한다는) 솔버의 핵심 성질이다.
function minDefenseFrequency(sizeFrac) {
  const s = Math.max(0, sizeFrac);
  return 1 / (1 + s);
}

module.exports = {
  roundRaiseTo,
  quirkFactor,
  bigBlunderChance,
  mixFrequency,
  gtoBluffRatio,
  minDefenseFrequency,
};
