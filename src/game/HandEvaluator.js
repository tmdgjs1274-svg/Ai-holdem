'use strict';

// 7장(홀카드 2 + 보드 최대 5) 중 최고의 5장 조합을 찾아 핸드 랭크를 매긴다.
// 점수는 [카테고리, tiebreak1, tiebreak2, ...] 배열로 표현하고 사전식(lexicographic) 비교로 우열을 가린다.
//
// 카테고리: 9=스트레이트플러시 8=포카드 7=풀하우스 6=플러시 5=스트레이트
//           4=트리플 3=투페어 2=원페어 1=하이카드

const CATEGORY_NAMES = {
  9: '스트레이트 플러시',
  8: '포카드',
  7: '풀하우스',
  6: '플러시',
  5: '스트레이트',
  4: '트리플',
  3: '투페어',
  2: '원페어',
  1: '하이카드',
};

function combinations(arr, k) {
  const results = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return results;
  while (true) {
    results.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return results;
}

// 5장 정확히 평가. cards: [{rank, suit}] length 5
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // 스트레이트 판정 (에이스 로우 휠: A-5-4-3-2 포함)
  const uniqueRanksDesc = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = null;
  if (uniqueRanksDesc.length === 5) {
    if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) {
      straightHigh = uniqueRanksDesc[0];
    } else if (
      uniqueRanksDesc[0] === 14 &&
      uniqueRanksDesc[1] === 5 &&
      uniqueRanksDesc[2] === 4 &&
      uniqueRanksDesc[3] === 3 &&
      uniqueRanksDesc[4] === 2
    ) {
      straightHigh = 5; // 휠: 5-high 스트레이트
    }
  }

  // 랭크별 개수 집계 -> (count desc, rank desc) 정렬
  const countMap = new Map();
  for (const r of ranks) countMap.set(r, (countMap.get(r) || 0) + 1);
  const grouped = [...countMap.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const counts = grouped.map((g) => g[1]);

  if (straightHigh && isFlush) {
    return { category: 9, tiebreakers: [straightHigh], name: CATEGORY_NAMES[9] };
  }
  if (counts[0] === 4) {
    const quad = grouped[0][0];
    const kicker = grouped[1][0];
    return { category: 8, tiebreakers: [quad, kicker], name: CATEGORY_NAMES[8] };
  }
  if (counts[0] === 3 && counts[1] === 2) {
    return { category: 7, tiebreakers: [grouped[0][0], grouped[1][0]], name: CATEGORY_NAMES[7] };
  }
  if (isFlush) {
    return { category: 6, tiebreakers: ranks, name: CATEGORY_NAMES[6] };
  }
  if (straightHigh) {
    return { category: 5, tiebreakers: [straightHigh], name: CATEGORY_NAMES[5] };
  }
  if (counts[0] === 3) {
    const trips = grouped[0][0];
    const kickers = grouped.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return { category: 4, tiebreakers: [trips, ...kickers], name: CATEGORY_NAMES[4] };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = grouped.filter((g) => g[1] === 2).map((g) => g[0]).sort((a, b) => b - a);
    const kicker = grouped.find((g) => g[1] === 1)[0];
    return { category: 3, tiebreakers: [...pairs, kicker], name: CATEGORY_NAMES[3] };
  }
  if (counts[0] === 2) {
    const pair = grouped[0][0];
    const kickers = grouped.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return { category: 2, tiebreakers: [pair, ...kickers], name: CATEGORY_NAMES[2] };
  }
  return { category: 1, tiebreakers: ranks, name: CATEGORY_NAMES[1] };
}

function compareScore(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? -1;
    const bv = b.tiebreakers[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// cards: 2~7장. 5장 미만이면 평가 불가(프리플랍 비교 등에는 사용하지 않음).
function evaluateBest(cards) {
  if (cards.length < 5) {
    throw new Error('5장 이상 필요합니다');
  }
  if (cards.length === 5) {
    return { ...evaluate5(cards), cards };
  }
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!best || compareScore(score, best) > 0) {
      best = { ...score, cards: combo };
    }
  }
  return best;
}

// 여러 플레이어의 최고 핸드를 비교해 승자 인덱스(들, 스플릿 시 복수)를 반환
function rankPlayers(handsByPlayer) {
  // handsByPlayer: [{ playerId, best }]
  let bestScore = null;
  for (const h of handsByPlayer) {
    if (!bestScore || compareScore(h.best, bestScore) > 0) bestScore = h.best;
  }
  const winners = handsByPlayer.filter((h) => compareScore(h.best, bestScore) === 0);
  return winners.map((w) => w.playerId);
}

module.exports = { evaluateBest, compareScore, combinations, CATEGORY_NAMES };
