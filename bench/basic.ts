import chalk from 'chalk';
import { match, P } from 'ts-pattern';
import type { Result } from './util';
import { benchmark, generateRandomData, printBenchmarkStats } from './util';

function tspattern(result: Result) {
  const html = match(result)
    .with(
      { type: 'error', error: { foo: [1, 2] }, nice: '' },
      () => '<p>Oups! An error occured</p>',
    )
    .with({ type: 'ok', data: { type: 'text' } }, function (_) {
      return '<p>420</p>';
    })
    .with(
      { type: 'ok', data: { type: 'img', src: P.select() } },
      (src) => `<img src=${src} />`,
    )
    .otherwise(() => 'idk bro');
  return html;
}

function pattycake(result: Result) {
  let html;
  __patsy_temp_0: {
    if (
      result?.type === 'error' &&
      Array.isArray(result?.error?.foo) &&
      result?.error?.foo?.length >= 2 &&
      result?.error?.foo[0] === 1 &&
      result?.error?.foo[1] === 2
    ) {
      html = '<p>Oups! An error occured</p>';
      break __patsy_temp_0;
    }
    if (result?.type === 'ok' && result?.data?.type === 'text') {
      let _ = result;
      html = '<p>420</p>';
      break __patsy_temp_0;
    }
    if (
      result?.type === 'ok' &&
      result?.data?.type === 'img' &&
      result?.data?.src === 'hi'
    ) {
      let src = result;
      html = `<img src=${src} />`;
      break __patsy_temp_0;
    }
    html = 'idk bro';
    break __patsy_temp_0;
  }
  return html;
}

// const data = generateRandomData(100000)
// const data = generateRandomData(50_000_000)
// const data = generateRandomData(10_000_000)
const data = generateRandomData(10000);
const iterCount = 1000;

console.log(
  chalk.bold('Running benchmark'),
  `(${chalk.italic(iterCount)} iterations)\n`,
);

const [pattycakeIters, pattycakeTotal] = benchmark(
  (results) => results.map(pattycake),
  data,
  iterCount,
);
const [tspatIters, tspatTotal] = benchmark(
  (results) => results.map(tspattern),
  data,
  iterCount,
);

printBenchmarkStats('pattycake', pattycakeIters, pattycakeTotal);
printBenchmarkStats('ts-pattern', tspatIters, tspatTotal);

console.log(chalk.bold('Summary'));
console.log(
  `  '${chalk.blue('pattycake')}' ran ${chalk.bold.green(
    (tspatTotal / pattycakeTotal).toFixed(4),
  )} times faster than '${chalk.red('ts-pattern')}'`,
);

export {};
