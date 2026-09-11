'use strict';

// 핸드 참여 순서 배열(order: [SB, BB, UTG, ..., CO, BTN], 헤즈업은 [BB, BTN])을 받아
// 특정 좌석의 포지션 이름을 반환한다. GameEngine(상태 표시)과 AI 로직 양쪽에서 공용으로 사용.
function getPositionCategory(order, seatIndex) {
  const k = order.length;
  const p = order.indexOf(seatIndex);
  if (p === -1) return null;
  if (k === 2) return p === k - 1 ? 'BTN' : 'BB';
  if (p === k - 1) return 'BTN';
  if (p === 0) return 'SB';
  if (p === 1) return 'BB';
  const middleCount = k - 3;
  const middleIdx = p - 2;
  if (middleCount <= 1) return 'CO';
  const f = middleIdx / (middleCount - 1);
  if (f < 0.34) return 'UTG';
  if (f < 0.67) return 'MP';
  return 'CO';
}

const POSITION_LABEL_KO = {
  BTN: '버튼(D)',
  SB: 'SB',
  BB: 'BB',
  UTG: 'UTG',
  MP: 'MP',
  CO: 'CO',
};

module.exports = { getPositionCategory, POSITION_LABEL_KO };
