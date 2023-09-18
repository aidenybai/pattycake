import type { PluginItem, PluginObj } from '@babel/core';
import { transformAsync } from '@babel/core';
import pluginSyntaxJsx from '@babel/plugin-syntax-jsx';
import pluginSyntaxTypescript from '@babel/plugin-syntax-typescript';
import { declare } from '@babel/helper-plugin-utils';
import { createUnplugin } from 'unplugin';
import * as t from '@babel/types';

export interface Options {}

export const unplugin = createUnplugin((options: Options) => {
  return {
    enforce: 'pre',
    name: 'ts-pattern-compiler',
    transformInclude(id: string) {
      return /\.[jt]s[x]?$/.test(id);
    },
    async transform(code: string, id: string) {
      const plugins: PluginItem[] = [[pluginSyntaxJsx]];

      const isTypescript = /\.ts[x]?$/.test(id);
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

export const babelPlugin = declare((api, options: Options) => {
  api.assertVersion(7);

  const plugin: PluginObj = {
    name: 'ts-pattern-compiler',
    visitor: {},
  };
  return plugin;
});
