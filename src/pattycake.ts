import { NodePath, PluginObj } from '@babel/core';
import * as b from '@babel/types';
import { HirTransform, callExpressionsFlat, hirFromCallExpr } from './hir';
import {
  HirCodegen,
  HirCodegenOpts,
  hirCodegen,
  hirCodegenInit,
} from './codegen';

export type Opts = HirCodegenOpts;

type State = {
  matchIdentifier: string | undefined;
  patternIdentifier: string | undefined;
};
const pattycakePlugin = (opts: Opts): PluginObj => {
  let state: State = {
    matchIdentifier: undefined,
    patternIdentifier: undefined,
  };
  let hirTransform: HirTransform | undefined = undefined;
  return {
    name: 'pattycake',
    visitor: {
      Program(path) {
        path.traverse<State>(
          {
            ImportDeclaration(path, state) {
              if (path.node.source.value != 'ts-pattern') return;

              for (const specifier of path.node.specifiers) {
                if (!b.isImportSpecifier(specifier)) continue;
                if (
                  b.isIdentifier(specifier.imported) &&
                  specifier.imported.name === 'match'
                ) {
                  state.matchIdentifier = specifier.local.name;
                  continue;
                }
                if (
                  b.isIdentifier(specifier.imported) &&
                  (specifier.imported.name === 'Pattern' ||
                    specifier.imported.name === 'P')
                ) {
                  state.patternIdentifier = specifier.local.name;
                  continue;
                }
              }
            },
          },
          state,
        );
        if (state.matchIdentifier !== undefined) {
          hirTransform = {
            matchIdentifier: state.matchIdentifier,
            patternIdentifier: state.patternIdentifier,
          };
        }
      },
      CallExpression(path) {
        if (hirTransform === undefined) return;

        if (!terminatesMatchExpression(hirTransform, path)) return;

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
              path.parentPath.parentPath!.replaceWithMultiple([
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
                b.variableDeclarator(hc.patternOriginalOutVar!, hc.outVar),
              ]);
              // parent should be VariableDeclarator
              // parent parent should be VariableDeclaration
              path.parentPath.parentPath!.replaceWithMultiple([
                letDecl,
                exprOrLabelStmt,
                assignBack,
              ]);
              break;
            }
            case 'assignment': {
              // parent should be AssignmentExpression
              // parent parent should be ExpressionStatement
              path.parentPath.parentPath!.replaceWith(exprOrLabelStmt);
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

/**
 * Determines if this nested tree of call expressions is a complete ts-pattern match expression
 *
 * This is done simply by looking at the last call expression, and checking if the callee is a function that
 * terminates the match expression (.otherwise(), .run(), .exhaustive())
 *
 * Without this, the compiler will attempt to build the HIR and codegen it for each chained function on the match expression
 **/
function terminatesMatchExpression(
  ht: HirTransform,
  callExpr: NodePath<b.CallExpression>,
): boolean {
  const callExprs = callExpressionsFlat(ht, callExpr.node);
  if (callExprs === undefined) return false;

  const last = callExprs[callExprs.length - 1]!;
  if (!b.isMemberExpression(last.callee)) return false;
  if (!b.isIdentifier(last.callee.property)) return false;
  switch (last.callee.property.name) {
    case 'otherwise':
    case 'run':
    case 'exhaustive':
      return true;
  }
  return false;
}

export default pattycakePlugin;
