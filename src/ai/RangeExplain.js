'use strict';

/**
 * AI 액션 리뷰용: AI가 실제로 가정한 "상대 예상 범위"를 실제 홀카드 조합으로 펼쳐서,
 * 지금 보드 기준으로 그 범위가 어떻게 구성되는지(나보다 앞선 패/약한 패 비율과 예시,
 * 보드의 가장 높은 카드를 가진 비율, 플러시 노림수 비율)를 계산한다.
 *
 * - AI의 판단에는 전혀 쓰이지 않는다(설명 전용). AI가 이퀴티 계산에 쓴 것과 같은 범위
 *   (RangeModel의 프리플랍 행동 태그 → Chen 점수 구간, 태그가 없으면 아무 패나)를 그대로 쓴다.
 * - "현재 카드 기준" 비교다(앞으로 나올 카드는 고려하지 않음). AI의 "이길 확률"은 앞으로 나올
 *   카드까지 반영한 값이라 이 비율과 정확히 같지는 않다.
 * - 보드 평가 결과는 같은 보드 안에서 캐시해 재사용한다(여러 AI/상대가 같은 보드를 공유).
 */

const { evaluateBest, compareScore } = require('../game/HandEvaluator');
const { makeDeck, cardToString } = require('../game/Deck');
const { chenScore } = require('./Equity');
const { rangeBoundsForTag } = require('./RangeModel');

const RANK_TXT = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
// 카드 숫자 뒤 목적격 조사(을/를) - 읽는 소리 기준(K=케이→를, 10=십→을 ...)
const RANK_OBJ = { 2: '를', 3: '을', 4: '를', 5: '를', 6: '을', 7: '을', 8: '을', 9: '를', 10: '을', 11: '를', 12: '를', 13: '를', 14: '를' };
const SUIT_TXT = { s: '♠', h: '♥', d: '♦', c: '♣' };

function rankText(r) {
  return RANK_TXT[r] || String(r);
}
function rankWithObj(r) {
  return `${rankText(r)}${RANK_OBJ[r] || '를'}`;
}

// 홀카드 두 장을 사람들이 부르는 이름으로: "AK", "KQ 수딧", "77"
function comboClass(c1, c2) {
  const [a, b] = c1.rank >= c2.rank ? [c1, c2] : [c2, c1];
  if (a.rank === b.rank) return `${rankText(a.rank)}${rankText(b.rank)}`;
  return `${rankText(a.rank)}${rankText(b.rank)}${a.suit === b.suit ? ' 수딧' : ''}`;
}

/** 보드별 상대 조합 평가 캐시. 보드가 바뀌면 새로 만든다. */
class BoardEvalCache {
  constructor() {
    this.boardKey = null;
    this.map = new Map();
  }
  get(board, c1, c2) {
    const key = board.map(cardToString).join('');
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.map = new Map();
    }
    const k = cardToString(c1) < cardToString(c2) ? cardToString(c1) + cardToString(c2) : cardToString(c2) + cardToString(c1);
    let v = this.map.get(k);
    if (!v) {
      v = evaluateBest([c1, c2, ...board]);
      this.map.set(k, v);
    }
    return v;
  }
}

// 예시 패 고르기: 그 범위 안에서 조합 수가 많은(=자주 나오는) 패 순서, 같으면 더 대표적인(강한) 패 먼저.
// counter: 이름 -> { n: 조합 수(가중치 합), strength: 대표 강도 }
function topExamples(counter, n = 4) {
  return [...counter.entries()]
    .sort((x, y) => (y[1].n - x[1].n) || (y[1].strength - x[1].strength))
    .slice(0, n)
    .map(([name]) => name);
}
function bump(counter, name, w, strength) {
  const cur = counter.get(name);
  if (cur) cur.n += w;
  else counter.set(name, { n: w, strength });
}

/**
 * @param engine GameEngine (포스트플랍)
 * @param heroSeat 리뷰 대상 AI 좌석
 * @param oppSeat 상대 좌석
 * @param tag RangeModel 태그(AI가 이 상대에게 실제로 적용한 것) 또는 null(아무 패나 가정)
 * @param cache BoardEvalCache (선택)
 */
function explainOpponentRange(engine, heroSeat, oppSeat, tag, cache = new BoardEvalCache(), weighted = null) {
  const board = engine.board || [];
  if (board.length < 3) return null;
  const hero = engine.hs[heroSeat].holeCards;
  const dead = new Set([...hero, ...board].map(cardToString));
  const bounds = tag ? rangeBoundsForTag(engine, oppSeat, tag) : null;
  const heroScore = evaluateBest([...hero, ...board]);
  const deck = makeDeck().filter((c) => !dead.has(cardToString(c)));

  const topRank = Math.max(...board.map((c) => c.rank));
  const suitCount = {};
  for (const c of board) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  const [flushSuit, flushCnt] = Object.entries(suitCount).sort((a, b) => b[1] - a[1])[0];
  const flushRelevant = flushCnt >= 2;

  let total = 0, ahead = 0, behind = 0, tie = 0, hitTop = 0, flushTwo = 0;
  const aheadCls = new Map();
  const behindCls = new Map();
  // weighted(LineReader 가중 범위)가 있으면 AI가 실제로 쓴 가중치 그대로, 없으면 프리플랍 구간 필터(또는 아무 패나)
  const visit = (c1, c2, w) => {
    total += w;
    const sc = cache.get(board, c1, c2);
    const cmp = compareScore(sc, heroScore);
    const cls = comboClass(c1, c2);
    const strength = chenScore(c1, c2);
    if (cmp > 0) { ahead += w; bump(aheadCls, cls, w, strength); }
    else if (cmp < 0) { behind += w; bump(behindCls, cls, w, strength); }
    else tie += w;
    if (c1.rank === topRank || c2.rank === topRank) hitTop += w;
    if (flushRelevant && c1.suit === flushSuit && c2.suit === flushSuit) flushTwo += w;
  };
  let comboCount = 0;
  if (weighted && weighted.combos) {
    for (const cb of weighted.combos) { visit(cb.c1, cb.c2, cb.w); comboCount++; }
  } else {
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        const c1 = deck[i];
        const c2 = deck[j];
        if (bounds) {
          const s = chenScore(c1, c2);
          if (s < bounds.min) continue;
          if (bounds.max != null && s > bounds.max) continue;
        }
        visit(c1, c2, 1);
        comboCount++;
      }
    }
  }
  if (!total) return null;
  const pct = (n) => Math.round((n / total) * 100);
  return {
    total: comboCount,
    weighted: !!(weighted && weighted.combos),
    aheadPct: pct(ahead),
    behindPct: pct(behind),
    tiePct: pct(tie),
    examplesAhead: topExamples(aheadCls),
    examplesBehind: topExamples(behindCls),
    topRank,
    topRankText: rankText(topRank),
    topRankObj: rankWithObj(topRank),
    topHitPct: pct(hitTop),
    flushSuit: flushRelevant ? SUIT_TXT[flushSuit] : null,
    flushMade: flushCnt >= 3,
    flushPct: flushRelevant ? pct(flushTwo) : null,
    heroHandName: heroScore.name,
  };
}

/** 상대 한 명에 대한 쉬운 말 한 줄(자세히 보기용) */
function breakdownLine(b) {
  if (!b) return null;
  const parts = [];
  parts.push(`보드의 ${b.topRankObj} 가진 패 ${b.topHitPct}%`);
  parts.push(`지금 카드 기준 나보다 앞선 패 ${b.aheadPct}%${b.examplesAhead.length ? `(예: ${b.examplesAhead.join(', ')})` : ''}`);
  parts.push(`내가 이기는 패 ${b.behindPct}%${b.examplesBehind.length ? `(예: ${b.examplesBehind.join(', ')})` : ''}`);
  if (b.flushSuit) parts.push(`${b.flushSuit} 두 장(${b.flushMade ? '플러시 완성' : '플러시 노림수'}) ${b.flushPct}%`);
  return `예상 범위 풀어보기(${b.weighted ? '베팅 흐름까지 반영한 비중' : `약 ${b.total}가지 조합`}): ${parts.join(' · ')}`;
}

/** 이유 박스에 넣을 핵심 문장(주로 상대 한 명 기준) */
function keySentence(name, josaEunFn, b, facingBetFromThisOpp, lineInfo = null) {
  if (!b) return null;
  let s = `${name}${josaEunFn(name)} 보드의 ${b.topRankObj} 들고 있을 확률이 약 ${b.topHitPct}%이고, 지금 카드 기준으로 나보다 앞선 패가 약 ${b.aheadPct}%${b.examplesAhead.length ? `(${b.examplesAhead.slice(0, 3).join(', ')} 등)` : ''}, 나보다 약한 패가 약 ${b.behindPct}%${b.examplesBehind.length ? `(${b.examplesBehind.slice(0, 3).join(', ')} 등)` : ''}라고 봤어요.`;
  if (b.flushSuit && b.flushPct >= 10) {
    s += ` ${b.flushSuit} 두 장으로 ${b.flushMade ? '플러시를 이미 완성했을' : '플러시를 노리고 있을'} 가능성도 약 ${b.flushPct}% 있어요.`;
  }
  if (facingBetFromThisOpp) {
    if (lineInfo && lineInfo.considered && lineInfo.shares) {
      const sp = (v) => Math.round(v * 100);
      s += ` 이번 베팅까지의 흐름${lineInfo.lineText ? `('${lineInfo.lineText}')` : ''}을 반영하면, 이 상대는 강한 패 약 ${sp(lineInfo.shares.strong)}%, 아무것도 없는 패로 하는 허세 약 ${sp(lineInfo.shares.weak)}%라고 봤어요.`;
      if (lineInfo.shares.weak >= 0.25) s += ' 허세일 가능성이 꽤 있다고 본 거예요.';
      else if (lineInfo.shares.weak <= 0.1) s += ' 허세일 가능성은 낮다고 본 거예요.';
    } else {
      s += ' 이 AI는 실력 설정상 상대의 베팅 흐름을 반영하지 않고, 이 범위 그대로 베팅했다고 보고 계산했어요.';
    }
  }
  return s;
}

module.exports = { explainOpponentRange, breakdownLine, keySentence, comboClass, BoardEvalCache, rankWithObj };
