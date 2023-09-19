import { PluginObj } from '@babel/core';
import * as b from '@babel/types';
import { HirTransform, hirFromCallExpr } from './hir';
import {
  HirCodegen,
  HirCodegenOpts,
  hirCodegen,
  hirCodegenInit,
} from './codegen';

export type Opts = HirCodegenOpts;

const patsyPlugin = (opts: Opts): PluginObj => {
  let state: { importName: string | undefined } = {
    importName: undefined,
  };
  let hirTransform: HirTransform | undefined = undefined;
  return {
    name: 'patsy',
    visitor: {
      Program(path) {
        path.traverse<{ importName: string | undefined }>(
          {
            ImportDeclaration(path, state) {
              if (path.node.source.value != 'ts-pattern') return;

              for (const specifier of path.node.specifiers) {
                if (
                  b.isImportSpecifier(specifier) &&
                  specifier.imported.type === 'Identifier'
                ) {
                  state.importName = specifier.local.name;
                  return;
                }
              }
            },
          },
          state,
        );
        if (state.importName !== undefined) {
          hirTransform = {
            importName: state.importName,
          };
        }
      },
      CallExpression(path) {
        if (hirTransform === undefined) return;

        try {
          const pat = hirFromCallExpr(hirTransform, path.node);
          if (pat === undefined) return;

          let hc: HirCodegen = hirCodegenInit(path, opts);
          const exprOrLabelStmt = hirCodegen(hc, pat);

          if (hc.kind === 'iife') {
            path.replaceWith(exprOrLabelStmt);
            return;
          }

          switch (hc.type) {
            case 'var-decl': {
              const letDecl = b.variableDeclaration('let', [
                b.variableDeclarator(hc.outVar),
              ]);
              // parent should be VariableDeclarator
              // parent parent should be VariableDeclaration
              path.parentPath.parentPath.replaceWithMultiple([
                letDecl,
                exprOrLabelStmt,
              ]);
              break;
            }
            case 'pattern-var-decl': {
              const letDecl = b.variableDeclaration('let', [
                b.variableDeclarator(hc.outVar),
              ]);
              if (!b.isIdentifier(hc.outVar)) throw new Error('unreachable');
              const assignBack = b.variableDeclaration('let', [
                b.variableDeclarator(hc.patternOriginalOutVar, hc.outVar),
              ]);
              // parent should be VariableDeclarator
              // parent parent should be VariableDeclaration
              path.parentPath.parentPath.replaceWithMultiple([
                letDecl,
                exprOrLabelStmt,
                assignBack,
              ]);
              break;
            }
            case 'assignment': {
              // parent should be AssignmentExpression
              // parent parent should be ExpressionStatement
              path.parentPath.parentPath.replaceWith(exprOrLabelStmt);
              break;
            }
          }
        } catch (err) {
          console.error(err);
        }
      },
    },
  };
};

export default patsyPlugin;
