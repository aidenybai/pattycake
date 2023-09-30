import chalk from 'chalk';

export type Data =
  | { type: 'text'; content: string }
  | { type: 'img'; src: string };

export type Error = {
  foo: Array<number>;
};

export type Result =
  | { type: 'ok'; data: Data }
  | { type: 'error'; error: Error };

export function generateRandomData(amount: number): Array<Result> {
  const results: Array<Result> = [];

  for (let i = 0; i < amount; i++) {
    // Randomly choose between 'ok' and 'error'
    const isOk = Math.random() > 0.5;

    if (isOk) {
      // Further choose between 'text' and 'img'
      const isText = Math.random() > 0.5;
      const data: Data = isText
        ? { type: 'text', content: `Random Text ${i}` }
        : { type: 'img', src: `http://example.com/image${i}.jpg` };

      results.push({ type: 'ok', data });
    } else {
      // Generate a random array of numbers for the 'foo' field in Error
      // with a random length between 1 and 10
      const randomLength = Math.floor(Math.random() * 10) + 1;
      const randomArray = Array.from({ length: randomLength }, () =>
        Math.floor(Math.random() * 100),
      );

      results.push({ type: 'error', error: { foo: randomArray } });
    }
  }

  return results;
}

// Benchmark function
export function benchmark(
  fn: (input: Result[]) => void,
  data: () => Array<Result>,
  iterAmount: number,
): [iterations: number[], elapsed: number] {
  const iterations: number[] = [];
  const totalStart = performance.now();

  for (let i = 0; i < iterAmount; i++) {
    const d = data();
    const start = performance.now();
    fn(d);
    const end = performance.now();
    iterations.push(end - start);
  }

  return [iterations, performance.now() - totalStart];
}

export function printBenchmarkStats(
  label: string,
  iterations: number[],
  elapsed: number,
) {
  // Calculate mean
  const mean =
    iterations.reduce((sum, val) => sum + val, 0) / iterations.length;

  // Calculate standard deviation
  const variance =
    iterations.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    iterations.length;
  const stdDev = Math.sqrt(variance);

  // Calculate min and max
  const min = Math.min(...iterations);
  const max = Math.max(...iterations);

  const fixAmount = 5;

  // Print stats
  console.log(chalk.bold('Benchmark:'), `${chalk.italic(label)}`);
  console.log(
    `  Time  (${chalk.bold.green('mean')} ± ${chalk.bold.green(
      'σ',
    )}):     ${chalk.bold.green(
      mean.toFixed(fixAmount),
    )} ms ±  ${chalk.bold.green(
      stdDev.toFixed(fixAmount),
    )} ms    (per iteration)`,
  );
  console.log(
    `  Range (${chalk.cyan('min')} … ${chalk.magenta('max')}):    ${chalk.cyan(
      min.toFixed(fixAmount),
    )} ms …  ${chalk.magenta(max.toFixed(fixAmount))} ms    ${
      iterations.length
    } runs`,
  );
  console.log(
    `  Total:                ${chalk.bold.green(
      elapsed.toFixed(fixAmount),
    )} ms`,
  );
  console.log();
}
