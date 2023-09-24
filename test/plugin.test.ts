import { pluginTester } from 'babel-plugin-tester';
import { babelPlugin } from '../src/plugin';

pluginTester({
  plugin: babelPlugin,
  filepath: 'test.ts',
  babelOptions: {
    presets: ['@babel/preset-typescript'],
  },
  tests: [
    {
      title: 'Basic',
      code: `
import { match } from 'ts-pattern';

type Data =
  | { type: 'text'; content: string }
  | { type: 'img'; src: string };

type Error = {
  foo: Array<number>
}

type Result =
  | { type: 'ok'; data: Data }
  | { type: 'error'; error: Error };

const result: Result = undefined;

const html = match(result)
    .with({ type: 'error', error: { foo: [1, 2]} }, () => "<p>Oups! An error occured</p>")
    .with({ type: 'ok', data: { type: 'text' } }, function (_) {
      return "<p>420</p>"
    })
    .with({ type: 'ok', data: { type: 'img', src: 'hi' } }, (src) => \`<img src=\${ src } />\`)
    .otherwise(() => 'idk bro');
      `,
      output: `import { match } from 'ts-pattern';
const result = undefined;
let html;
__patsy_temp_0: {
  if (
    result?.type === 'error' &&
    Array.isArray(result?.error?.foo) &&
    result?.error?.foo?.length >= 2 &&
    (result?.error?.foo)[0] === 1 &&
    (result?.error?.foo)[1] === 2
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
    html = \`<img src=\${src} />\`;
    break __patsy_temp_0;
  }
  html = (() => 'idk bro')(result);
  break __patsy_temp_0;
}`,
    },
    {
      title: 'Select',
      code: `
import { match, P } from 'ts-pattern';

type Data =
  | { type: 'text'; content: string }
  | { type: 'img'; src: string };

type Error = {
  foo: Array<number>
}

type Result =
  | { type: 'ok'; data: Data }
  | { type: 'error'; error: Error };

const result: Result = undefined;

const foo = match(result)
  // anonymous
  .with({ type: 'bar', name: P.select() }, (sel, matchExpr) => console.log(sel, matchExpr))
  // anonymous with subpattern
  .with({ type: 'bar2', name: P.select(P.string) }, (sel, matchExpr) => console.log(sel, matchExpr))
  // named
  .with({ type: 'baz', name: P.select('hey') }, (sel, matchExpr) => console.log(sel, matchExpr))
  // named with sub pattern
  .with({ type: 'blah', name: P.select('hey', P.number) }, (sel, matchExpr) => console.log(sel, matchExpr))
      `,
      output: `import { match, P } from 'ts-pattern';
const result = undefined;
let foo;
__patsy_temp_0: {
  if (result?.type === 'bar') {
    let sel = result?.name;
    let matchExpr = result;
    foo = console.log(sel, matchExpr);
    break __patsy_temp_0;
  }
  if (result?.type === 'bar2' && typeof result?.name === 'string') {
    let sel = result?.name;
    let matchExpr = result;
    foo = console.log(sel, matchExpr);
    break __patsy_temp_0;
  }
  if (result?.type === 'baz') {
    let sel = {
      ['hey']: result?.name,
    };
    let matchExpr = result;
    foo = console.log(sel, matchExpr);
    break __patsy_temp_0;
  }
  if (result?.type === 'blah' && typeof result?.name === 'number') {
    let sel = {
      ['hey']: result?.name,
    };
    let matchExpr = result;
    foo = console.log(sel, matchExpr);
    break __patsy_temp_0;
  }
  let __patsy__displayedValue;
  try {
    __patsy__displayedValue = JSON.stringify(result);
  } catch (e) {
    __patsy__displayedValue = result;
  }
  throw new Error(
    \`Pattern matching error: no pattern matches value \${__patsy__displayedValue}\`
  );
}
`,
    },
  ],
});
