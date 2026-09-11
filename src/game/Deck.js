'use strict';

// 카드 표현: { rank: 2-14 (11=J,12=Q,13=K,14=A), suit: 's'|'h'|'d'|'c' }
// 문자열 표현(직렬화/디버깅용): "As", "Td", "2c" 등

const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const SUITS = ['s', 'h', 'd', 'c'];
const RANK_CHAR = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function cardToString(card) {
  return `${RANK_CHAR[card.rank]}${card.suit}`;
}

function cardFromString(str) {
  const rankChar = str.slice(0, -1);
  const suit = str.slice(-1);
  return { rank: CHAR_RANK[rankChar.toUpperCase()], suit };
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Fisher-Yates shuffle. rng는 0~1 난수 함수 (테스트에서 시드 고정용으로 주입 가능)
function shuffle(deck, rng = Math.random) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Shoe {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.cards = shuffle(makeDeck(), this.rng);
  }

  draw() {
    if (this.cards.length === 0) {
      throw new Error('덱에 카드가 없습니다');
    }
    return this.cards.pop();
  }

  drawN(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.draw());
    return out;
  }

  remaining() {
    return this.cards.length;
  }
}

module.exports = { makeDeck, shuffle, Shoe, cardToString, cardFromString, RANKS, SUITS };
