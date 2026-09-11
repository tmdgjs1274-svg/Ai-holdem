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
  console.log('\n== TableManager ==');
  await require('./tableManager.test').run();
  console.log('\n모든 테스트 통과 ✅');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
