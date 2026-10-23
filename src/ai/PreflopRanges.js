'use strict';

const { chenScore } = require('./Equity');
const { roundRaiseTo, quirkFactor, bigBlunderChance, mixFrequency } = require('./util');
const { getPositionCategory } = require('../game/Position');
const { handStrengthLabel, positionKo, describeHandActions, josaIga, fmtChips } = require('./Explain');

// 9-max 기준 포지션별 오픈레이즈 최소 점수 (풀링 기준선)
const BASE_OPEN_THRESHOLD = {
  UTG: 8,
  MP: 7,
  CO: 6,
  BTN: 4.5,
  SB: 5.5,
  BB: 6, // BB 앞에 리밈만 있고 레이즈가 없을 때 이소레이즈 기준
};

// 테이블 인원수가 적을수록 레인지를 넓힌다 (9명 기준 대비 보정치)
function loosenForTableSize(threshold, numActive) {
  const delta = (9 - numActive) * 0.35;
  return Math.max(threshold - delta, -1);
}

// 상대적으로 몇 번의 레이즈가 있었는지 베팅 사이즈로 근사 추정
function estimateRaiseLevel(engine) {
  const bb = engine.bigBlind;
  if (engine.currentBet <= bb) return 0;
  if (engine.currentBet <= bb * 3.5) return 1;
  if (engine.currentBet <= bb * 9) return 2;
  return 3;
}

/**
 * 프리플랍 의사결정에 필요한 컨텍스트를 계산.
 */
function buildPreflopContext(engine, seatIndex) {
  const order = engine.handSeatsInOrder();
  const numActive = order.length;
  const position = getPositionCategory(order, seatIndex);
  const seat = engine.seats[seatIndex];
  const hs = engine.hs[seatIndex];
  const score = chenScore(hs.holeCards[0], hs.holeCards[1]);
  const effectiveStackBb = seat.stack / engine.bigBlind;
  const raiseLevel = estimateRaiseLevel(engine);
  const openThreshold = loosenForTableSize(BASE_OPEN_THRESHOLD[position] ?? 7, numActive);
  return { order, numActive, position, score, effectiveStackBb, raiseLevel, openThreshold };
}

/**
 * 숏스택 푸시/폴드 구간 여부와 셔브 임계값.
 * 스택이 짧을수록, 포지션이 늦을수록 셔브 범위가 넓어진다.
 */
function pushFoldThreshold(position, stackBb) {
  const posAdj = { UTG: 1.5, MP: 0.5, CO: -1, BTN: -2.5, SB: -1.5, BB: -1 }[position] ?? 0;
  // 15bb에서 기준 7점, 스택이 줄어들수록 완만히 낮아짐 (5bb 근처에서 매우 넓어짐)
  const base = 7 + posAdj - (15 - stackBb) * 0.35;
  return Math.max(base, 0.5);
}

// 포지션별 기본 오픈레이즈 배수(빅블라인드 기준). 늦은 포지션일수록 조금 더 작게,
// 이른 포지션일수록 조금 더 크게 여는 실제 사람들의 경향을 대략 반영한다.
const OPEN_RAISE_BASE_MULT = { UTG: 3, MP: 2.7, CO: 2.4, BTN: 2.2, SB: 3, BB: 2.5 };

function sizePreflopRaise(engine, legal, ctx, rng) {
  const bb = engine.bigBlind;
  const rand = rng || Math.random;
  let raiseTo;
  if (ctx.raiseLevel === 0) {
    // 예전에는 항상 정확히 bb의 정수배로 반올림해서 사실상 매번 3bb로 고정되어 버렸다.
    // 2~3bb 사이에서 포지션에 따라, 그리고 약간의 무작위성으로 자연스럽게 오픈 사이즈가
    // 달라지도록 한다(정수 bb배로 딱 떨어뜨리지 않고 100원 단위로만 반올림).
    const baseMult = OPEN_RAISE_BASE_MULT[ctx.position] ?? 2.5;
    const jitter = (rand() - 0.5) * 0.6; // ±0.3bb
    const mult = Math.max(2, Math.min(3, baseMult + jitter));
    raiseTo = engine.currentBet + bb * (mult - 1);
  } else {
    raiseTo = engine.currentBet * 3;
  }
  raiseTo = Math.max(legal.minRaiseTo, Math.min(raiseTo, legal.maxRaiseTo));
  return roundRaiseTo(raiseTo, legal, 100); // 100원 단위로 보기 좋게 반올림
}

/**
 * 프리플랍 액션 결정. 반환: { actionType, amount? }
 *
 * 예전에는 skillLevel(항상 적용되는 판단 잡음)과 mistakeRate(드문 큰 실수)를 독립된 축으로
 * 따로 뒀지만, "실력을 100%로 올려도 mistakeRate 축이 남아있어 여전히 가끔 이상한 플레이가
 * 나온다"는 혼란이 있어 이제는 큰 실수도 skillLevel 하나에서 유도한다(util.bigBlunderChance -
 * skillLevel=100이면 정확히 0). skillLevel이 낮을수록 손패 강도 평가 자체가 흔들려서,
 * 오픈/콜/폴드 경계선에서 잘못된 선택을 더 자주 하게 된다.
 */
function decidePreflop(engine, seatIndex, legal, opts = {}) {
  const rng = opts.rng || Math.random;
  const skill = Math.max(0, Math.min(100, opts.skillLevel != null ? opts.skillLevel : 75));
  const ctx = buildPreflopContext(engine, seatIndex);
  // skill===75(기존 기본값)에서는 1이라서 아래 고정 확률 잡버릇들의 세기가 그대로 유지되고,
  // skill=100이면 0이 되어 "실력 100%인데도 림프/3벳블러프가 나온다"는 문제가 사라진다.
  const quirk = quirkFactor(skill);
  // 3벳/4벳 블러프, 3벳에 대한 콜다운처럼 "실수"가 아니라 실력이 높아도 유지되는 밸런스
  // 전략 확률에는 mixFrequency를 쓴다(quirk와 달리 skill=100에서도 0으로 사라지지 않음).
  const mix = mixFrequency(skill);
  let score = ctx.score;
  if (rng() < bigBlunderChance(skill)) score += (rng() - 0.5) * 4; // 사람같은 실수: 핸드 강도 인식 오차(실력 100%면 0)
  score += (rng() - 0.5) * (1 - skill / 100) * 3; // 실력이 낮을수록 항상 섞이는 잔잡음

  // raiseLevel===0: 아직 아무도 빅블라인드 이상으로 레이즈하지 않은 "오픈되지 않은" 팟.
  // (BB를 완성하기 위해 콜해야 하는 금액이 있어도 이는 "실제 레이즈에 대응"이 아니라 "오픈 여부 결정"임)
  const unopenedPot = ctx.raiseLevel === 0;

  const POS = ctx.position;
  const sc = score.toFixed(1);
  const lvName = ['오픈 전', '오픈 레이즈 상대', '3벳 상대', '4벳 이상 상대'][ctx.raiseLevel] || '레이즈 상대';
  // 쉬운 말 설명용: 패 등급 / 자리 이름 / 상대가 어떻게 나왔는지 (판단에는 영향 없음)
  const label = handStrengthLabel(score);
  const adj = label.replace(/ 패$/, ''); // '약한', '애매한' 처럼 '패' 없이 꾸며주는 말
  const posKo = positionKo(POS);
  // 아래 설명 조각(누가 얼마까지 올렸는지 등)은 리뷰용일 뿐이므로, 만들다 실패해도 AI의 판단에는
  // 영향이 없도록 try/catch로 감싸고, 실패하면 단순한 문구로 대체한다.
  const explainPre = () => {
    try {
      // 누가 얼마까지 올렸는지(공개된 정보)를 설명에 반영한다. 프리플랍 판단은 실제로 "앞선 레이즈 크기"를
      // 기준으로 하므로(estimateRaiseLevel), 그 크기를 빅블라인드 배수로 보여준다.
      const raiserSeat = engine.lastAggressorSeat;
      const raiserName =
        raiserSeat != null && raiserSeat >= 0 && raiserSeat !== seatIndex && engine.seats[raiserSeat]
          ? engine.seats[raiserSeat].displayName
          : null;
      const raiseBb = engine.bigBlind ? Math.round((engine.currentBet / engine.bigBlind) * 10) / 10 : 0;
      const raiseWho = raiserName ? `${raiserName}${josaIga(raiserName)}` : '상대가';
      const facing = ctx.raiseLevel >= 2
        ? `${raiseWho} 판돈을 빅블라인드의 ${raiseBb}배까지 계속 올린 상황`
        : `${raiseWho} 판돈을 빅블라인드의 ${raiseBb}배까지 올린 상황`;
      const situation = `${label} · ${posKo} · ${ctx.numActive}명 참여`;
      const preflopReads = {
        headline: ctx.raiseLevel > 0
          ? `앞서 ${raiseWho} 판돈을 올렸어요(빅블라인드의 ${raiseBb}배, ${fmtChips(engine.currentBet)}). 많이 올릴수록 상대 패가 강하다고 보고 더 신중하게 판단해요.`
          : '아직 아무도 판돈을 올리지 않았어요(열려 있는 판).',
        opponents: ctx.order
          .filter((i) => i !== seatIndex && engine.hs[i] && !engine.hs[i].folded)
          .map((i) => {
            const acts = describeHandActions(engine.actionLog, i);
            return { seatIndex: i, name: engine.seats[i].displayName, items: [acts ? `이번 핸드 행동: ${acts}` : '이번 핸드 행동: 아직 없음(블라인드만 낸 상태)'], tag: null };
          }),
        effects: [],
        notes: ['프리플랍은 내 패의 등급, 내 자리(포지션), 남은 인원, 내 칩 양, 앞서 올린 크기를 기준으로 판단해요. 상대 개인의 평소 성향과 예상 패 분석은 플랍부터 반영해요.'],
      };
      return { facing, situation, preflopReads };
    } catch (err) {
      return {
        facing: ctx.raiseLevel >= 2 ? '상대가 계속 판돈을 올린 상황' : '상대가 판돈을 올린 상황',
        situation: `${label} · ${posKo}`,
        preflopReads: null,
      };
    }
  };
  const { facing, situation, preflopReads } = explainPre();
  const mk = (plain, detail) => ({ reason: plain, situation, detail, reads: preflopReads });

  if (ctx.effectiveStackBb <= 15) {
    let shoveThresh = pushFoldThreshold(ctx.position, ctx.effectiveStackBb);
    if (!unopenedPot) shoveThresh += 1 + ctx.raiseLevel;
    const stk = Math.round(ctx.effectiveStackBb);
    const stkPlain = `칩이 얼마 남지 않아(빅블라인드 약 ${stk}개 분량) 올인하거나 포기하는 두 가지 선택만 남은 상황이에요.`;
    if (score >= shoveThresh) {
      if (legal.canRaise) {
        return { actionType: 'allin', ...mk(`${stkPlain} 이 패는 올인해 볼 만하다고 보고 전부 걸었어요.`, `숏스택 푸시/폴드(${stk}bb): ${POS} 핸드 점수 ${sc} ≥ 셔브 기준 ${shoveThresh.toFixed(1)} → 올인`) };
      }
      return { actionType: legal.canCall ? 'call' : 'check', ...mk(`${stkPlain} 올인할 만한 패지만 더 올릴 수는 없어서 그대로 따라갔어요.`, `숏스택(${stk}bb): 점수 ${sc} ≥ 기준 ${shoveThresh.toFixed(1)}이나 레이즈 불가 → 콜/체크`) };
    }
    if (unopenedPot && legal.canCheck) return { actionType: 'check', ...mk(`${stkPlain} 올인할 만한 패는 아니지만 공짜로 볼 수 있어서 체크했어요.`, `숏스택(${stk}bb): 점수 ${sc} < 셔브 기준 ${shoveThresh.toFixed(1)}, 공짜로 체크`) };
    return { actionType: 'fold', ...mk(`${stkPlain} 올인할 만큼 강한 패가 아니라서 이번 판은 포기했어요.`, `숏스택(${stk}bb): ${POS} 점수 ${sc} < 셔브 기준 ${shoveThresh.toFixed(1)} → 폴드`) };
  }

  const openThresh = ctx.openThreshold + ctx.raiseLevel * 2.2;
  const raiseThresh = openThresh + 3.5;
  const callThresh = openThresh - 1.7;

  if (unopenedPot) {
    // 오픈 여부 결정: 레이즈-오어-폴드 원칙 (림프는 최소화, 가끔 사람처럼 림프)
    if (score >= openThresh) {
      if (legal.canRaise) {
        return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng), ...mk(score >= 9 ? `${label}라서 판돈을 올려 판을 먼저 시작했어요.` : `패는 ${adj} 편이지만 ${posKo}에서는 이 정도 패로도 먼저 판돈을 올려 판을 시작해 볼 만하다고 봤어요.`, `${POS} 오픈 레이즈: 점수 ${sc} ≥ 오픈 기준 ${openThresh.toFixed(1)}(${ctx.numActive}인 테이블 보정 반영)`) };
      }
      if (legal.canCheck) return { actionType: 'check', ...mk(`올려 볼 만한 패지만 올릴 수 없는 상황이라 체크했어요.`, `점수 ${sc} ≥ 오픈 기준이나 레이즈 불가 → 체크`) };
      return { actionType: 'call', ...mk(`올려 볼 만한 패지만 올릴 수 없는 상황이라 따라갔어요.`, `점수 ${sc} ≥ 오픈 기준이나 레이즈 불가 → 콜`) };
    }
    if (legal.canCheck) return { actionType: 'check', ...mk(`빅블라인드라 공짜로 다음 카드를 볼 수 있어요. 올릴 만큼 좋은 패는 아니어서 그냥 체크했어요.`, `BB 무료 옵션: 점수 ${sc} < 오픈 기준 ${openThresh.toFixed(1)}이라 레이즈 없이 체크`) };
    if (legal.canCall && rng() < 0.06 * quirk) return { actionType: 'call', ...mk(`${label}라서 보통은 접는 상황인데, 가끔은 일부러 싸게 들어가서 상대가 내 패를 읽기 어렵게 만들어요.`, `${POS} 림프: 점수 ${sc}로 오픈 기준(${openThresh.toFixed(1)}) 미달이나 낮은 확률의 림프 섞기(실력이 높을수록 줄어듦)`) };
    return { actionType: 'fold', ...mk(`${label}인데 ${posKo}에서는 불리해서, 돈을 쓰지 않고 포기했어요.`, `${POS} 폴드: 점수 ${sc} < 오픈 기준 ${openThresh.toFixed(1)}`) };
  }

  // 실제 레이즈(또는 3벳 이상)에 대응하는 상황
  const bluffWindow = score >= callThresh - 1 && score < openThresh && ['BTN', 'CO', 'SB'].includes(ctx.position);
  // 3벳(이상) 블러프 확률. 0.12는 다소 잦다는 피드백을 반영해 0.09로 낮췄다. 이건 실수가 아니라
  // 밸런스를 위해 실력이 높아도 어느 정도 유지되어야 하는 확률이라 mixFrequency를 쓴다
  // (실력 100%에서도 완전히 0이 되지 않고 절반 정도(0.045)는 유지됨 - "실력 100%인데 3벳/4벳
  // 블러프를 전혀 안 한다"는 피드백을 반영).
  const bluffRoll = rng() < 0.09 * mix && ctx.numActive <= 5;

  if (score >= raiseThresh && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng), ...mk(`${facing}이지만 내 패(${label})가 상대보다 앞선다고 보고, 다시 크게 올렸어요.`, `${POS} 밸류 ${ctx.raiseLevel >= 2 ? '4벳+' : '3벳'}: ${lvName}, 점수 ${sc} ≥ 레이즈 기준 ${raiseThresh.toFixed(1)}`) };
  }
  if (bluffWindow && bluffRoll && legal.canRaise) {
    return { actionType: 'raise', amount: sizePreflopRaise(engine, legal, ctx, rng), ...mk(`패는 ${adj} 편이지만 ${posKo}라서 일부러 센 척(허세)하며 크게 다시 올렸어요. 강한 패로만 올리면 상대가 읽어버려서 가끔 이렇게 섞어요.`, `${POS} 블러프 3벳: 점수 ${sc}(콜 기준 ${callThresh.toFixed(1)} 부근)로 늦은 포지션 + 소수 인원 → 밸런스용 블러프 레이즈(빈도 ${(0.09 * mix * 100).toFixed(1)}%)`) };
  }
  if (score >= callThresh) {
    if (legal.canCheck) return { actionType: 'check', ...mk(`추가로 낼 돈이 없어서 그냥 체크했어요.`, `점수 ${sc} ≥ 콜 기준 ${callThresh.toFixed(1)}, 추가 비용 없이 체크`) };
    if (legal.canCall) return { actionType: 'call', ...mk(`${facing}이에요. 다시 올릴 만큼 강하진 않지만 내 패(${label})를 그냥 버리긴 아깝다고 보고 따라갔어요.`, `${POS} 콜: ${lvName}, 점수 ${sc}가 콜 기준 ${callThresh.toFixed(1)} 이상 ~ 레이즈 기준 ${raiseThresh.toFixed(1)} 미만`) };
    return { actionType: 'fold', ...mk(`따라갈 수 없는 상황이라 포기했어요.`, `콜 불가 상황 → 폴드`) };
  }
  // callThresh에 살짝 못 미치지만 가끔 더 버텨보는 콜(3벳/4벳에 대한 콜다운 포함). 이것도
  // "실수"가 아니라 레인지를 너무 타이트하게 읽히지 않기 위한 밸런스 플레이라 mixFrequency를
  // 쓴다 - 실력 100%에서도 절반 정도(2.5%)는 유지되어 "3벳에 콜을 전혀 안 한다"는 문제를 줄인다.
  if (legal.canCall && rng() < 0.05 * mix) {
    return { actionType: 'call', ...mk(`${label}라서 보통은 접는 상황인데, 너무 쉽게 접으면 상대가 마음껏 올릴 수 있어서 이번에는 일부러 버텨 봤어요.`, `${POS} 밸런스 콜: 점수 ${sc} < 콜 기준 ${callThresh.toFixed(1)}이나 너무 타이트하게 읽히지 않도록 가끔 버티는 콜(빈도 ${(0.05 * mix * 100).toFixed(1)}%)`) };
  }
  return legal.canCheck
    ? { actionType: 'check', ...mk(`추가로 낼 돈이 없어서 그냥 체크했어요.`, `점수 ${sc} < 콜 기준이나 무료로 체크`) }
    : { actionType: 'fold', ...mk(`${facing}인데, 내 패(${label})로는 따라가 봐야 손해라고 보고 포기했어요.`, `${POS} 폴드: ${lvName}, 점수 ${sc} < 콜 기준 ${callThresh.toFixed(1)}`) };
}

module.exports = {
  getPositionCategory,
  buildPreflopContext,
  pushFoldThreshold,
  decidePreflop,
  sizePreflopRaise,
  BASE_OPEN_THRESHOLD,
};
