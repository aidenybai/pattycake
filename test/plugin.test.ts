import { pluginTester } from 'babel-plugin-tester';
import { babelPlugin } from '../src/plugin';

pluginTester({
  plugin: babelPlugin,
  tests: [
    {
      title: '',
      code: '',
      output: '',
    },
  ],
});
