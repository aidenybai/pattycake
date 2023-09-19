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
      title: '',
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
  ],
});
