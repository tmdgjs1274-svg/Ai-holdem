'use strict';

// 프로덕션 HandEvaluator를 완전히 독립적으로 재구현한 참조(reference) 평가기와
// 수만 건의 무작위 7장 핸드에 대해 교차검증한다. (사용자가 "투페어인데 원페어에게 졌다"고
// 보고한 것에 대한 정밀 검증 목적 — 카테고리 분류/비교 로직에 버그가 없는지 별도 구현으로 재확인)

const assert = require('assert');
const { makeDeck, shuffle, cardToString } = require('../src/game/Deck');
const { evaluateBest, combinations } = require('../src/game/HandEvaluator');

// ---- 완전히 별도로 작성한 참조 구현 (비트마스크 방식 스트레이트 판정 등 다른 접근) ----
function refEvaluate5(cards) {
  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const rankSet = new Set(ranks);
  let mask = 0;
  for (const r of rankSet) mask |= 1 << r;
  if (rankSet.has(14)) mask |= 1 << 1; // 에이스는 로우로도 취급 (휠)

  let straightTop = null;
  for (let low = 10; low >= 1; low--) {
    let need = 0;
    for (let k = 0; k < 5; k++) need |= 1 << (low + k);
    if ((mask & need) === need) {
      straightTop = low + 4;
      break;
    }
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const pattern = groups.map((g) => g.count).join(',');

  if (straightTop && isFlush) return { cat: 9, tb: [straightTop] };
  if (pattern === '4,1') return { cat: 8, tb: [groups[0].rank, groups[1].rank] };
  if (pattern === '3,2') return { cat: 7, tb: [groups[0].rank, groups[1].rank] };
  if (isFlush) return { cat: 6, tb: ranks.slice().sort((a, b) => b - a) };
  if (straightTop) return { cat: 5, tb: [straightTop] };
  if (pattern === '3,1,1') return { cat: 4, tb: [groups[0].rank, groups[1].rank, groups[2].rank] };
  if (pattern === '2,2,1') {
    const pairs = groups.filter((g) => g.count === 2).map((g) => g.rank).sort((a, b) => b - a);
    const kicker = groups.find((g) => g.count === 1).rank;
    return { cat: 3, tb: [...pairs, kicker] };
  }
  if (pattern === '2,1,1,1') {
    const kickers = groups.filter((g) => g.count === 1).map((g) => g.rank).sort((a, b) => b - a);
    return { cat: 2, tb: [groups[0].rank, ...kickers] };
  }
  return { cat: 1, tb: ranks.slice().sort((a, b) => b - a) };
}

function refCompare(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const len = Math.max(a.tb.length, b.tb.length);
  for (let i = 0; i < len; i++) {
    const av = a.tb[i] ?? -1;
    const bv = b.tb[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function refEvaluateBest(cards7) {
  const combos = combinations(cards7, 5);
  let best = null;
  for (const c of combos) {
    const s = refEvaluate5(c);
    if (!best || refCompare(s, best) > 0) best = s;
  }
  return best;
}

const CATEGORY_KO = {
  9: '스트레이트플러시', 8: '포카드', 7: '풀하우스', 6: '플러시',
  5: '스트레이트', 4: '트리플', 3: '투페어', 2: '원페어', 1: '하이카드',
};

function seedRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run() {
  const rng = seedRng(20260911);
  const ITER = 30000;
  let categoryMismatches = 0;
  let orderMismatches = 0;
  const examples = [];

  for (let i = 0; i < ITER; i++) {
    const deck = shuffle(makeDeck(), rng);
    // 두 플레이어(7장씩 겹치는 보드 5장 + 서로 다른 홀카드 2장)를 무작위로 구성
    const board = deck.slice(0, 5);
    const h1 = deck.slice(5, 7);
    const h2 = deck.slice(7, 9);
    const cards1 = [...h1, ...board];
    const cards2 = [...h2, ...board];

    const prod1 = evaluateBest(cards1);
    const prod2 = evaluateBest(cards2);
    const ref1 = refEvaluateBest(cards1);
    const ref2 = refEvaluateBest(cards2);

    if (prod1.category !== ref1.cat || prod2.category !== ref2.cat) {
      categoryMismatches++;
      if (examples.length < 5) {
        examples.push({
          hand: cards1.map(cardToString).join(' '),
          prodCategory: CATEGORY_KO[prod1.category],
          refCategory: CATEGORY_KO[ref1.cat],
        });
      }
    }

    // 프로덕션 compareScore와 참조 refCompare가 승패를 동일하게 판정하는지 (부호 방향만 비교)
    const { compareScore } = require('../src/game/HandEvaluator');
    const prodSign = Math.sign(compareScore(prod1, prod2));
    const refSign = Math.sign(refCompare(ref1, ref2));
    if (prodSign !== refSign) {
      orderMismatches++;
      if (examples.length < 10) {
        examples.push({
          board: board.map(cardToString).join(' '),
          hero: h1.map(cardToString).join(' '),
          villain: h2.map(cardToString).join(' '),
          prodHeroCategory: CATEGORY_KO[prod1.category],
          prodVillainCategory: CATEGORY_KO[prod2.category],
          prodSign,
          refSign,
        });
      }
    }
  }

  console.log(`핸드 평가기 교차검증: ${ITER}회 무작위 대결 실행`);
  console.log(`  카테고리 불일치: ${categoryMismatches}건`);
  console.log(`  승패 판정 불일치: ${orderMismatches}건`);
  if (examples.length) {
    console.log('  예시:', JSON.stringify(examples, null, 2));
  }

  assert.strictEqual(categoryMismatches, 0, '프로덕션 평가기와 독립 참조 평가기의 핸드 카테고리 분류가 항상 일치해야 함');
  assert.strictEqual(orderMismatches, 0, '프로덕션 평가기와 독립 참조 평가기의 승패 판정이 항상 일치해야 함');
  console.log('HandEvaluatorFuzz: 통과 (두 독립 구현이 30000회 전부 일치)');
}

module.exports = { run };

if (require.main === module) {
  run();
}
