import type { PluginItem, PluginObj } from '@babel/core';
import { transformAsync } from '@babel/core';
import pluginSyntaxJsx from '@babel/plugin-syntax-jsx';
import pluginSyntaxTypescript from '@babel/plugin-syntax-typescript';
import { declare } from '@babel/helper-plugin-utils';
import { createUnplugin } from 'unplugin';
import pattycakePlugin, { Opts } from './pattycake';

export type Options = Opts;

export const unplugin = createUnplugin((options: Opts) => {
  return {
    enforce: 'pre',
    name: 'pattycake',
    transformInclude(id: string) {
      return /\.[jt]sx?$/.test(id);
    },
    async transform(code: string, id: string) {
      const plugins: PluginItem[] = [[pluginSyntaxJsx]];

      const isTypescript = /\.tsx?$/.test(id);
      if (isTypescript) {
        plugins.push([
          pluginSyntaxTypescript,
          { allExtensions: true, isTSX: id.endsWith('.tsx') },
        ]);
      }

      plugins.push([babelPlugin, options]);

      const result = await transformAsync(code, { plugins, filename: id });

      return result?.code || null;
    },
  };
});

export const babelPlugin = declare((api, options: Opts) => {
  api.assertVersion(7);

  return pattycakePlugin(options);
});
