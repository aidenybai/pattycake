import chalk from 'chalk';
import { generateHeapSnapshot } from 'bun';
import { match, P } from 'ts-pattern';
import type { Result } from './util';
import { heapStats } from 'bun:jsc';
import { benchmark, generateRandomData, printBenchmarkStats } from './util';

function tspattern(result: Result) {
  const html = match(result)
    .with(
      { type: 'error', error: { foo: P.select('foo') }, nice: P.select('hi') },
      ({ foo, hi }) => `<p>${foo} ${hi}</p>`,
    )
    .with(
      { type: 'ok', data: { type: 'text', content: P.select() } },
      function (content) {
        return `<p>${content}</p>`;
      },
    )
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
    if (result?.type === 'error') {
      let sel = {
        ['foo']: result?.error?.foo,
        ['hi']: result?.nice,
      };
      html = `<p>$sel.foo} ${sel.hi}</p>`;
      break __patsy_temp_0;
    }
    if (result?.type === 'ok' && result?.data?.type === 'text') {
      let content = result?.data?.content;
      html = `<p>${content}</p>`;
      break __patsy_temp_0;
    }
    if (result?.type === 'ok' && result?.data?.type === 'img') {
      let src = result?.data?.src;
      html = `<img src=${src} />`;
      break __patsy_temp_0;
    }
    html = (() => 'idk bro')(result);
    break __patsy_temp_0;
  }
}

const iterCount = 1000;

console.log(
  chalk.bold('Running benchmark'),
  `(${chalk.italic(iterCount)} iterations)\n`,
);

const [pattycakeIters, pattycakeTotal] = benchmark(
  (results) => results.map(pattycake),
  () => generateRandomData(10000),
  iterCount,
);
const [tspatIters, tspatTotal] = benchmark(
  (results) => results.map(tspattern),
  () => generateRandomData(10000),
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
