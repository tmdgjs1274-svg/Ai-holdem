'use strict';

/**
 * 상대의 "베팅 흐름(라인)"을 읽어서 상대 예상 범위를 스트리트마다 다시 저울질한다.
 *
 * 예전 모델은 상대의 프리플랍 행동(올림/여러 번 올림/콜/공짜 체크) 하나로만 범위를 정하고,
 * 플랍 이후에 상대가 체크했든 크게 베팅했든 같은 범위로 계산했다. 그래서 "턴에 크게 베팅하고
 * 리버에 또 크게 베팅"한 상대도 프리플랍 범위 전체(약한 패 포함)를 그대로 갖고 있다고 보고,
 * 반대로 계속 체크만 한 상대도 강한 패를 그대로 많이 가진 것으로 봤다.
 *
 * 이 모듈은 상대가 가질 수 있는 모든 홀카드 조합 각각에 "가중치"를 매긴다:
 *   가중치 = 프리플랍 행동과의 일치도 × (플랍·턴·리버에서 한 각 행동이 그 패로 나올 법한 정도)
 * 각 스트리트에서 그 조합이 그 시점 보드에서 어떤 상태였는지(강한 패/애매한 패/드로우/아무것도 없음)를
 * 빠르게 분류하고, 행동별로 "이런 상태의 패라면 이렇게 행동할 법한 정도"를 곱한다. 예를 들어 큰 베팅은
 * 강한 패에서 많이 나오지만 아무것도 없는 패(허세)에서도 일정 부분 나오므로(폴라라이즈), 큰 베팅을 한
 * 상대의 범위는 "강한 패 + 일부 허세" 쪽으로 쏠리고 애매한 패의 비중은 줄어든다. 이 가중치가 곧
 * "이 베팅이 허세일 확률"(아무것도 없는 패의 비중)이 된다.
 *
 * AI의 이길 확률 계산(Equity.estimateEquity)은 이 가중치대로 상대 패를 뽑아 시뮬레이션한다.
 */

const { makeDeck, cardToString } = require('../game/Deck');
const { chenScore } = require('./Equity');
const { rangeBoundsForTag } = require('./RangeModel');

const STREET_BOARD_LEN = { flop: 3, turn: 4, river: 5 };

// 행동별 "이 상태의 패라면 이 행동을 할 법한 정도"(0~1, 상대적 값).
// 큰 베팅/레이즈는 강한 패와 허세 쪽으로 양극화(폴라라이즈)되고, 콜은 애매한 패·드로우 쪽,
// 체크는 약한 패·애매한 패 쪽에서 많이 나온다는 일반적인 원칙을 단순화한 값이다.
const ACTION_LIKELIHOOD = {
  check: { strong: 0.35, medium: 0.9, draw: 0.75, weak: 1.0 },
  call: { strong: 0.55, medium: 1.0, draw: 0.9, weak: 0.12 },
  betSmall: { strong: 0.9, medium: 0.6, draw: 0.6, weak: 0.35 },
  betBig: { strong: 1.0, medium: 0.3, draw: 0.5, weak: 0.35 },
  raise: { strong: 1.0, medium: 0.18, draw: 0.45, weak: 0.22 },
};
// 프리플랍 행동과 맞지 않는 패도 완전히 0으로 만들지는 않는다(상대가 가끔 예외적으로 플레이할 수 있음).
const PREFLOP_OUTSIDE_WEIGHT = 0.08;

// ---- 패 상태 빠른 분류 ----

function straightHigh(ranks) {
  // ranks: Set of ranks (2~14). A는 1로도 취급(A-2-3-4-5).
  const has = (r) => ranks.has(r) || (r === 1 && ranks.has(14));
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let r = hi; r > hi - 5; r--) if (!has(r)) { ok = false; break; }
    if (ok) return hi;
  }
  return 0;
}

/**
 * 홀카드 2장이 이 보드에서 어떤 상태인지:
 *  strong(투페어 이상/셋/스트레이트/플러시/오버페어/좋은 키커의 탑페어),
 *  medium(그 외 원페어 - 약한 키커 탑페어, 세컨페어 이하, 보드보다 낮은 포켓페어),
 *  draw(페어는 없지만 플러시 드로우/양방향 스트레이트 드로우 - 리버 전까지만),
 *  weak(아무것도 없음 - 허세나 포기할 패)
 */
function quickStrength(hole, board) {
  const [h1, h2] = hole;
  const all = [...hole, ...board];
  const cnt = {};
  for (const c of all) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
  const bcnt = {};
  for (const c of board) bcnt[c.rank] = (bcnt[c.rank] || 0) + 1;
  const maxBoard = Math.max(...board.map((c) => c.rank));

  // 플러시(홀카드 최소 1장 사용)
  const suitCnt = {};
  for (const c of all) suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
  for (const [s, n] of Object.entries(suitCnt)) {
    if (n >= 5 && (h1.suit === s || h2.suit === s)) return 'strong';
  }
  // 스트레이트(보드만으로 된 것보다 높아야 홀카드를 쓴 것)
  const allRanks = new Set(all.map((c) => c.rank));
  const boardRanks = new Set(board.map((c) => c.rank));
  const sAll = straightHigh(allRanks);
  if (sAll && sAll > straightHigh(boardRanks)) return 'strong';
  // 셋/트립스/풀하우스/포카드(홀카드가 관여)
  if (cnt[h1.rank] >= 3 || cnt[h2.rank] >= 3) return 'strong';
  // 두 장 모두 쓴 투페어
  if (h1.rank !== h2.rank && bcnt[h1.rank] >= 1 && bcnt[h2.rank] >= 1) return 'strong';
  // 포켓페어
  if (h1.rank === h2.rank) return h1.rank > maxBoard ? 'strong' : 'medium';
  // 탑페어
  if (h1.rank === maxBoard || h2.rank === maxBoard) {
    const kicker = h1.rank === maxBoard ? h2.rank : h1.rank;
    return kicker >= 11 ? 'strong' : 'medium';
  }
  // 그 외 원페어
  if (bcnt[h1.rank] >= 1 || bcnt[h2.rank] >= 1) return 'medium';

  // 드로우(리버 전)
  if (board.length < 5) {
    for (const [s, n] of Object.entries(suitCnt)) {
      if (n === 4 && (h1.suit === s || h2.suit === s)) return 'draw';
    }
    // 양방향 스트레이트 드로우: 연속 4장(홀카드 포함) + 양쪽 끝이 열려 있음
    const has = (r) => allRanks.has(r) || (r === 1 && allRanks.has(14));
    for (let lo = 2; lo <= 10; lo++) {
      let ok = true;
      for (let r = lo; r < lo + 4; r++) if (!has(r)) { ok = false; break; }
      if (!ok) continue;
      const usesHole = [h1.rank, h2.rank].some((r) => r >= lo && r < lo + 4);
      if (usesHole && lo - 1 >= 2 && lo + 4 <= 14) return 'draw';
    }
  }
  return 'weak';
}

// ---- 상대 행동 해석 ----

/** 액션 로그 한 줄을 ACTION_LIKELIHOOD의 키로 바꾼다(포스트플랍만). */
function classifyAction(entry) {
  const t = entry.actionType;
  if (t === 'check') return 'check';
  if (t === 'call') return 'call';
  if (t === 'fold') return null;
  if (t === 'bet' || t === 'raise' || t === 'allin') {
    const toCall = entry.toCallBefore || 0;
    if (toCall > 0) {
      // 올인 금액이 콜 금액 이하라면 사실상 콜
      if (t === 'allin' && (entry.amount || 0) <= toCall) return 'call';
      return 'raise';
    }
    if (t === 'allin') return 'betBig';
    const pot = entry.potBefore;
    if (!pot) return 'betSmall';
    return (entry.amount || 0) / pot >= 0.6 ? 'betBig' : 'betSmall';
  }
  return null;
}

const ACTION_KO = {
  check: '체크',
  call: '콜',
  betSmall: '작은 베팅',
  betBig: '큰 베팅',
  raise: '레이즈',
};
const STREET_KO = { flop: '플랍', turn: '턴', river: '리버' };

/** 상대의 포스트플랍 행동들 [{street, kind}] (현재 스트리트 포함, 순서대로) */
function postflopLine(engine, oppSeat) {
  const out = [];
  for (const e of engine.actionLog || []) {
    if (e.seatIndex !== oppSeat || e.street === 'preflop' || !STREET_BOARD_LEN[e.street]) continue;
    const kind = classifyAction(e);
    if (kind) out.push({ street: e.street, kind });
  }
  return out;
}

function lineText(line) {
  if (!line.length) return null;
  return line.map((l) => `${STREET_KO[l.street]} ${ACTION_KO[l.kind]}`).join(' → ');
}

/**
 * 상대 한 명의 가중 범위를 만든다.
 * @param engine
 * @param oppSeat
 * @param deadCards 이미 보이는 카드(히어로 홀카드 + 보드)
 * @param {object} opts { tag: 프리플랍 태그|null, bluffAdj: 베팅/레이즈 시 '아무것도 없는 패' 가중치 배율(상대 성향) }
 * @returns {{ combos: Array<{c1,c2,w,cls}>, total:number, cum: Float64Array, shares, line }}
 */
function buildWeightedRange(engine, oppSeat, deadCards, opts = {}) {
  const tag = opts.tag || null;
  const bluffAdj = opts.bluffAdj || 1;
  const bounds = tag ? rangeBoundsForTag(engine, oppSeat, tag) : null;
  const dead = new Set(deadCards.map(cardToString));
  const deck = makeDeck().filter((c) => !dead.has(cardToString(c)));
  const line = postflopLine(engine, oppSeat);
  const fullBoard = engine.board || [];
  const curLen = fullBoard.length;
  const curBoard = fullBoard;

  const combos = [];
  let total = 0;
  const shares = { strong: 0, medium: 0, draw: 0, weak: 0 };
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const c1 = deck[i];
      const c2 = deck[j];
      let w = 1;
      if (bounds) {
        const s = chenScore(c1, c2);
        const inside = s >= bounds.min && (bounds.max == null || s <= bounds.max);
        if (!inside) w *= PREFLOP_OUTSIDE_WEIGHT;
      }
      for (const step of line) {
        const b = fullBoard.slice(0, STREET_BOARD_LEN[step.street]);
        if (b.length < 3) continue;
        const cls = quickStrength([c1, c2], b);
        let lk = ACTION_LIKELIHOOD[step.kind][cls];
        if (cls === 'weak' && (step.kind === 'betSmall' || step.kind === 'betBig' || step.kind === 'raise')) lk *= bluffAdj;
        w *= lk;
      }
      if (w <= 0) continue;
      const clsNow = curLen >= 3 ? quickStrength([c1, c2], curBoard) : 'weak';
      combos.push({ c1, c2, w, cls: clsNow });
      total += w;
      shares[clsNow] += w;
    }
  }
  const cum = new Float64Array(combos.length);
  let acc = 0;
  for (let k = 0; k < combos.length; k++) {
    acc += combos[k].w;
    cum[k] = acc;
  }
  if (total > 0) for (const k of Object.keys(shares)) shares[k] /= total;
  return { combos, total, cum, shares, line };
}

module.exports = {
  quickStrength,
  classifyAction,
  postflopLine,
  lineText,
  buildWeightedRange,
  ACTION_LIKELIHOOD,
};
