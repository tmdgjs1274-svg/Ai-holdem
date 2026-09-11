'use strict';

const { makeDeck } = require('../game/Deck');
const { evaluateBest, compareScore } = require('../game/HandEvaluator');

function cardKey(c) {
  return `${c.rank}${c.suit}`;
}

function remainingDeck(excludeCards) {
  const excludeSet = new Set(excludeCards.map(cardKey));
  return makeDeck().filter((c) => !excludeSet.has(cardKey(c)));
}

// pool에서 n장을 비복원 무작위 추출 (부분 Fisher-Yates)
function drawRandom(pool, n, rng) {
  const arr = pool.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
    out.push(arr[i]);
  }
  return out;
}

/**
 * 몬테카를로 시뮬레이션으로 히어로의 현재 이퀴티(지분)를 추정한다.
 * 상대 홀카드는 무작위(레인지 미지정)로 가정 - 정밀도는 낮지만 계산이 빠르고
 * 포지션/스택 기반 의사결정을 뒷받침하기엔 충분한 근사치를 제공한다.
 *
 * @param {Array} heroCards 히어로 홀카드 2장
 * @param {Array} board 현재 보드 (0,3,4,5장)
 * @param {number} numOpponents 아직 핸드에 남아있는 상대 수
 * @param {function} rng
 * @param {number} iterations
 * @returns {number} 0~1 사이 추정 이퀴티
 */
function estimateEquity(heroCards, board, numOpponents, rng = Math.random, iterations = 150) {
  if (numOpponents <= 0) return 1;
  const known = [...heroCards, ...board];
  const pool = remainingDeck(known);
  const neededBoard = 5 - board.length;
  const needed = neededBoard + numOpponents * 2;
  if (needed > pool.length) iterations = Math.max(20, Math.floor(iterations / 2));

  let equitySum = 0;
  for (let it = 0; it < iterations; it++) {
    const drawn = drawRandom(pool, needed, rng);
    const extraBoard = drawn.slice(0, neededBoard);
    const fullBoard = [...board, ...extraBoard];
    const heroScore = evaluateBest([...heroCards, ...fullBoard]);

    let bestOppScore = null;
    let tieCount = 1;
    for (let o = 0; o < numOpponents; o++) {
      const oppCards = [drawn[neededBoard + o * 2], drawn[neededBoard + o * 2 + 1]];
      const oppScore = evaluateBest([...oppCards, ...fullBoard]);
      if (!bestOppScore || compareScore(oppScore, bestOppScore) > 0) {
        bestOppScore = oppScore;
      }
    }

    const cmp = compareScore(heroScore, bestOppScore);
    if (cmp > 0) equitySum += 1;
    else if (cmp === 0) equitySum += 0.5; // 히어로 vs 최고상대 근사 스플릿(다중 타이 근사)
    // cmp < 0 -> 0
  }
  return equitySum / iterations;
}

// 프리플랍 간이 핸드 점수 (Chen 공식 변형). 값이 클수록 강한 핸드.
function chenScore(card1, card2) {
  const highRank = Math.max(card1.rank, card2.rank);
  const lowRank = Math.min(card1.rank, card2.rank);
  const isPair = card1.rank === card2.rank;
  const isSuited = card1.suit === card2.suit;
  const baseTable = { 14: 10, 13: 8, 12: 7, 11: 6, 10: 5 };
  let score = baseTable[highRank] !== undefined ? baseTable[highRank] : highRank / 2;

  if (isPair) {
    score = Math.max(score * 2, 5);
    return Math.round(score * 2) / 2;
  }

  if (isSuited) score += 2;

  const gap = highRank - lowRank - 1;
  if (gap === 0) score += 1;
  else if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  if (highRank <= 11 && gap <= 1) score += 1; // 낮은 스트레이트 완성 가능성 보너스

  return Math.round(Math.max(score, 0) * 2) / 2;
}

module.exports = { estimateEquity, chenScore, remainingDeck };
