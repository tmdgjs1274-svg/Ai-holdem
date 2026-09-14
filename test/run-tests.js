'use strict';

async function main() {
  console.log('== BlindStructure ==');
  require('./blindStructure.test').run();
  console.log('\n== HandEvaluator ==');
  require('./handEvaluator.test').run();
  console.log('\n== HandEvaluator 교차검증(Fuzz) ==');
  require('./handEvaluatorFuzz.test').run();
  console.log('\n== GameEngine ==');
  require('./gameEngine.test').run();
  console.log('\n== PreflopRaiseSizing ==');
  require('./preflopSizing.test').run();
  console.log('\n== BoardTexture ==');
  require('./boardTexture.test').run();
  console.log('\n== RangeModel ==');
  require('./rangeModel.test').run();
  console.log('\n== OpponentModel ==');
  require('./opponentModel.test').run();
  console.log('\n== AI 고급 전략(레인지/텍스처/익스플로잇/멀티스트리트) ==');
  require('./aiAdvanced.test').run();
  console.log('\n== TableManager ==');
  await require('./tableManager.test').run();
  console.log('\n모든 테스트 통과 ✅');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
