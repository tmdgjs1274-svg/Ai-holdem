'use strict';

async function main() {
  console.log('== HandEvaluator ==');
  require('./handEvaluator.test').run();
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
