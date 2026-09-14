'use strict';

/**
 * 보드(플랍/턴/리버)의 "텍스처"(드라이/웻)를 간단히 분류한다.
 * AI 실력(aiSkillLevel)이 높을수록 이 텍스처를 참고해 베팅 사이즈/빈도를 조정한다
 * (실력이 낮으면 팟 비율만 보는 고정된 구간별 확률을 그대로 쓴다).
 *
 * - paired: 보드에 페어가 있음 (풀하우스/포카드 가능성 + 좁아진 스트레이트/플러시 완성 카드)
 * - monotone: 보드 카드 전부가 한 무늬 (플러시 완성 카드가 이미 3장)
 * - twoTone: 한 무늬가 2장 이상 몰려 플러시 드로우가 가능한 정도
 * - connected: 보드 랭크들이 좁은 구간에 몰려 있어 스트레이트 가능성이 높음
 * - highRank: 보드에서 가장 높은 카드의 랭크
 * - wetness: 0(아주 드라이/정적) ~ 1(아주 웻/역동적). 위 요소들을 종합한 점수.
 */
function classifyBoardTexture(board) {
  if (!board || board.length < 3) {
    return { paired: false, trips: false, monotone: false, twoTone: false, connected: false, highRank: 0, wetness: 0 };
  }

  const ranks = board.map((c) => c.rank).sort((a, b) => a - b);
  const suits = board.map((c) => c.suit);

  const rankCounts = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
  const counts = Object.values(rankCounts);
  const paired = counts.some((c) => c >= 2);
  const trips = counts.some((c) => c >= 3);

  const suitCounts = {};
  for (const s of suits) suitCounts[s] = (suitCounts[s] || 0) + 1;
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  const monotone = maxSuitCount === board.length;
  const twoTone = !monotone && maxSuitCount >= 2;

  // 스트레이트 가능성: 서로 다른 랭크가 3개 이상이고, 가장 높은/낮은 카드 사이 간격이 좁으면
  // (예: 9-10-J, 7-8-9) 커넥티드로 본다. 페어가 낀 보드는 스트레이트 완성이 더 어려우므로 제외.
  const uniqueRanks = [...new Set(ranks)];
  const span = uniqueRanks[uniqueRanks.length - 1] - uniqueRanks[0];
  const connected = !paired && uniqueRanks.length >= 3 && span <= 4;

  const highRank = ranks[ranks.length - 1];

  let wetness = 0;
  if (monotone) wetness += 0.45;
  else if (twoTone) wetness += 0.25;
  if (connected) wetness += 0.35;
  if (paired) wetness += 0.15; // 페어보드는 드로우는 줄지만 트립/풀하우스 가능성으로 약간 웻하게 취급
  wetness = Math.min(1, wetness);

  return { paired, trips, monotone, twoTone, connected, highRank, wetness };
}

module.exports = { classifyBoardTexture };
