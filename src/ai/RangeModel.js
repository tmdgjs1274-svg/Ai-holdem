'use strict';

const { chenScore } = require('./Equity');
const { BASE_OPEN_THRESHOLD } = require('./PreflopRanges');
const { getPositionCategory } = require('../game/Position');

/**
 * engine.actionLog(이번 핸드 전체 액션 기록)에서, 특정 좌석이 "프리플랍에서" 보여준
 * 가장 공격적인 행동을 한 단어로 요약한다. actionLog가 없으면(테스트 등에서 engine을
 * 직접 조작해 로그가 비어있는 경우) null을 돌려줘서 레인지 추정을 건너뛰게 한다.
 */
function summarizePreflopAction(engine, seatIndex) {
  if (!engine.actionLog || engine.actionLog.length === 0) return null;
  const acts = engine.actionLog.filter((a) => a.seatIndex === seatIndex && a.street === 'preflop');
  if (acts.length === 0) return null;

  const aggressiveActs = acts.filter(
    (a) => a.actionType === 'raise' || a.actionType === 'bet' || a.actionType === 'allin'
  );
  if (aggressiveActs.length >= 2) return 'reraiser'; // 3벳 이상까지 간 경우
  if (aggressiveActs.length === 1) return 'raiser';
  if (acts.some((a) => a.actionType === 'call')) return 'caller';
  return 'checked_through'; // 빅블라인드가 공짜로 체크한 경우 등 - 레인지가 넓어 필터링 의미가 작음
}

/**
 * 프리플랍 행동 태그를 대략적인 Chen 점수 구간(레인지)으로 환산한다. 정밀한 콤보 단위
 * 레인지표는 아니고, PreflopRanges.js가 실제 오픈/3벳 결정에 쓰는 것과 같은 임계값을
 * 거꾸로 이용한 근사치다(예: 레이즈했다면 최소 오픈 임계값 이상의 손패였을 것이다).
 */
function rangeBoundsForTag(engine, seatIndex, tag) {
  const order = engine.handSeatsInOrder();
  const position = getPositionCategory(order, seatIndex) || 'MP';
  const base = BASE_OPEN_THRESHOLD[position] ?? 7;
  switch (tag) {
    case 'reraiser':
      return { min: base + 3.5 + 2.2, max: null };
    case 'raiser':
      return { min: base, max: null };
    case 'caller':
      return { min: Math.max(base - 1.7, 0), max: base + 3.5 };
    case 'checked_through':
      return { min: 0, max: base };
    default:
      return null;
  }
}

/**
 * 지금 핸드의 상대 좌석들(opponentSeatIndexes)에 대해, 각자의 프리플랍 액션을 바탕으로
 * postflop 이퀴티 계산(Equity.estimateEquity)에 넘길 "레인지 필터" 배열을 만든다.
 *
 * rangeWeight(0~1)는 aiSkillLevel에서 유도된 값으로, "이 필터를 실제로 적용할 확률"이다.
 * 0이면 필터를 전혀 안 만들고(=완전 무작위 상대 패 가정, 기존 동작과 동일), 1에 가까울수록
 * 거의 항상 상대의 프리플랍 액션에 맞는 레인지로 좁혀서 계산한다.
 *
 * @returns {Array<null|function(card,card):boolean>|null} opponentSeatIndexes와 같은 길이의
 *   필터 배열, 또는 적용할 필터가 하나도 없으면 null(=estimateEquity가 기존 방식대로 동작)
 */
function buildOpponentRangeFilters(engine, opponentSeatIndexes, rangeWeight, rng) {
  if (!rangeWeight || rangeWeight <= 0) return null;
  let anyFilter = false;
  const filters = opponentSeatIndexes.map((seatIdx) => {
    if (rng() > rangeWeight) return null; // 실력이 낮을수록 이 상대는 그냥 무작위로 취급
    const tag = summarizePreflopAction(engine, seatIdx);
    if (!tag) return null;
    const bounds = rangeBoundsForTag(engine, seatIdx, tag);
    if (!bounds) return null;
    anyFilter = true;
    return (c1, c2) => {
      const s = chenScore(c1, c2);
      if (s < bounds.min) return false;
      if (bounds.max != null && s > bounds.max) return false;
      return true;
    };
  });
  return anyFilter ? filters : null;
}

module.exports = { summarizePreflopAction, rangeBoundsForTag, buildOpponentRangeFilters };
