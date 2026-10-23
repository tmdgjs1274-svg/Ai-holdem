'use strict';

// AI 액션 리뷰에 쓰는 "일반인이 읽는 쉬운 말" 설명 조각 모음.
// 판단 로직에는 전혀 관여하지 않고, 이미 계산된 값을 사람이 이해하기 쉬운 문장으로 바꾸기만 한다.
// (기술적인 숫자 설명은 각 결정의 detail 필드에 따로 남겨두고, 화면에서는 "숫자 자세히 보기"로만 보여준다.)

// 프리플랍 핸드 점수(Chen 공식, 대략 -1~20)를 사람이 이해하는 등급으로 바꾼다.
function handStrengthLabel(score) {
  if (score >= 12) return '최상급 패';
  if (score >= 9) return '아주 좋은 패';
  if (score >= 6.5) return '쓸 만한 패';
  if (score >= 3.5) return '애매한 패';
  return '약한 패';
}

const POSITION_KO = {
  UTG: '가장 앞 순서',
  MP: '중간 순서',
  CO: '뒤쪽 순서',
  BTN: '버튼(가장 유리한 마지막 순서)',
  SB: '스몰블라인드',
  BB: '빅블라인드',
};
function positionKo(pos) {
  return POSITION_KO[pos] || pos;
}

// 족보 이름 옆에 초보자용 보충 설명을 붙인다.
function handNamePlain(name) {
  if (name === '하이카드') return '하이카드(아직 족보 없음)';
  if (name === '원페어') return '원페어(같은 숫자 한 쌍)';
  if (name === '트리플') return '트리플(같은 숫자 3장)';
  return name || '패';
}

// 보드 분위기를 쉬운 말로. wetness: 0(안정) ~ 1(위험)
function boardPlain(wetness) {
  if (wetness >= 0.6) return '위험한 보드(스트레이트·플러시가 나오기 쉬워 한 번에 뒤집힐 수 있음)';
  if (wetness >= 0.3) return '보통 보드';
  return '안정적인 보드(역전당할 위험이 적음)';
}

// 이름 뒤에 붙는 주격 조사(이/가). 받침이 있으면 '이', 없으면 '가'.
function josaIga(name) {
  const ch = String(name || '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '가' : '이';
  return '가';
}

// 이름 뒤에 붙는 보조사(은/는). 받침이 있으면 '은', 없으면 '는'.
function josaEun(name) {
  const ch = String(name || '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '는' : '은';
  return '는';
}

function fmtChips(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

// ---- 상대 분석(AI가 실제로 참고한 상대 정보)을 쉬운 말로 ----

// RangeModel의 태그 -> "그 상대가 쥐고 있을 법한 패"를 한 줄로
const RANGE_TAG_TEXT = {
  reraiser: { short: '아주 강한 패', full: '프리플랍에서 여러 번 올렸으니 아주 강한 패일 가능성이 높다고 봤어요' },
  raiser: { short: '꽤 괜찮은 패', full: '프리플랍에서 판돈을 올렸으니 꽤 괜찮은 패일 거라고 봤어요' },
  caller: { short: '중간 정도의 패', full: '프리플랍에서 올리지 않고 따라만 갔으니 아주 강하진 않은 중간 정도 패일 거라고 봤어요' },
  checked_through: { short: '약한 패까지 섞인 넓은 범위', full: '프리플랍에서 공짜로 넘어갔으니 약한 패까지 섞인 넓은 범위로 봤어요' },
};
function rangeTagText(tag) {
  return RANGE_TAG_TEXT[tag] || null;
}

// OpponentModel.summary -> 평소 성향 설명(표본이 부족하면 "아직 모름"으로 솔직하게)
function describeTendency(sum) {
  if (!sum) return '아직 이 상대의 성향을 판단할 만한 데이터가 없어요';
  const parts = [];
  if (sum.foldRate != null) {
    const pct = Math.round(sum.foldRate * 100);
    const kind = sum.foldRate >= 0.6 ? '잘 접는 편' : sum.foldRate <= 0.35 ? '잘 안 접는 편' : '보통';
    parts.push(`베팅을 받으면 ${pct}%를 접었어요(${sum.facedBet}번 중 ${sum.foldedToBet}번, ${kind})`);
  }
  if (sum.aggression != null) {
    const pct = Math.round(sum.aggression * 100);
    const kind = sum.aggression >= 0.6 ? '공격적인 편' : sum.aggression <= 0.35 ? '콜이 많은 수동적인 편' : '보통';
    parts.push(`액션 중 베팅·레이즈가 ${pct}%(${kind})`);
  }
  if (!parts.length) return `아직 이 상대의 성향을 판단할 만한 데이터가 부족해요(${sum.hands}핸드 관찰)`;
  return parts.join(', ');
}

const STREET_SHORT = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
// 이번 핸드에서 그 상대가 한 행동을 순서대로 한 줄로(공개된 정보만)
function describeHandActions(actionLog, seatIndex) {
  const acts = (actionLog || []).filter((a) => a.seatIndex === seatIndex);
  if (!acts.length) return null;
  const ko = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', bet: '베팅', allin: '올인' };
  return acts
    .map((a) => {
      const base = ko[a.actionType] || a.actionType;
      const amt = (a.actionType === 'raise' || a.actionType === 'bet' || a.actionType === 'allin') && a.amount ? ` ${fmtChips(a.amount)}` : '';
      return `${STREET_SHORT[a.street] || a.street} ${base}${amt}`;
    })
    .join(' → ');
}

module.exports = {
  handStrengthLabel, positionKo, handNamePlain, boardPlain, fmtChips,
  rangeTagText, describeTendency, describeHandActions, josaIga, josaEun,
};
