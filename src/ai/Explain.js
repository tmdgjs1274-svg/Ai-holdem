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

function fmtChips(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

module.exports = { handStrengthLabel, positionKo, handNamePlain, boardPlain, fmtChips };
