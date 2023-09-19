import { NodePath, PluginObj } from '@babel/core';
import * as b from '@babel/types';
import traverse from '@babel/traverse';

type Hir = PatternMatch;

type PatternMatch = {
  expr: Expr;
  branches: Array<PatternMatchBranch>;
  otherwise: Expr | undefined;
  exhaustive: boolean;
};

type Expr = b.Expression;
type FnExpr = b.ArrowFunctionExpression | b.FunctionExpression;

type PatternMatchBranch = {
  patterns: Array<Pattern>;
  guard: FnExpr | undefined;
  then: b.Expression;
};

type Pattern =
  | {
      type: 'literal';
      value: PatternLiteral;
    }
  | { type: 'object'; value: PatternObject }
  | { type: 'array'; value: PatternArray }
  | { type: 'wildcard'; value: unknown }
  | { type: 'matchfn'; value: unknown };

type PatternLiteral =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number };
type PatternObject = Record<string, Pattern>;
type PatternArray = Array<Pattern>;

/**
 * Extra state to be stored when transforming to Hir
 * */
type HirTransform = {
  importName: string;
};

const patsyPlugin = (opts: HirCodegenOpts): PluginObj => {
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
        console.log('HIR transform', hirTransform);
        if (hirTransform === undefined) return;

        try {
          const pat = hirTransformCallExpr(hirTransform, path.node);
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

function hirTransformCallExpr(
  ht: HirTransform,
  callExpr: b.CallExpression,
): PatternMatch | undefined {
  const depth = hirHasPatternMatchRoot(ht, callExpr);
  if (depth === 0) return undefined;

  const buf = Array<b.CallExpression>(depth).fill(
    undefined as unknown as b.CallExpression,
  );
  hirPatternMatchTopDownCallExprs(
    ht,
    callExpr,
    buf as unknown as Array<b.CallExpression>,
    depth - 1,
  );

  return hirTransformCallExprImpl(ht, buf);
}

function hirTransformCallExprImpl(
  ht: HirTransform,
  callExprs: Array<b.CallExpression>,
): PatternMatch | undefined {
  const expr = callExprs[0].arguments[0];
  if (!b.isExpression(expr)) return undefined;

  let exhaustive: boolean = false;
  let otherwise: b.Expression | undefined = undefined;
  const branches: Array<PatternMatchBranch> = [];

  for (let i = 1; i < callExprs.length; i++) {
    const callExpr = callExprs[i];
    const callee = callExpr.callee;
    if (!b.isMemberExpression(callee)) {
      throw new Error('unreachable');
    }
    const property = callee.property;
    if (!b.isIdentifier(property)) {
      throw new Error('unreachable');
    }

    switch (property.name) {
      case 'with': {
        const branch = hirTransformPatternMatchBranch(ht, callExpr.arguments);
        branches.push(branch);
        break;
      }
      case 'otherwise': {
        const arg = callExpr.arguments[0];
        if (b.isExpression(arg)) {
          otherwise = arg;
        } else if (b.isSpreadElement(arg)) {
          throw new Error('spread elements not handled yet');
        } else {
          throw new Error(`unhandled ${arg.type}`);
        }
        break;
      }
      case 'exhaustive': {
        exhaustive = true;
        break;
      }
      default: {
        throw new Error(`Unhandled ts-pattern API function: ${property.name}`);
      }
    }
  }

  return {
    expr,
    branches,
    exhaustive,
    otherwise,
  };
}

function isFunction(expr: b.Node): expr is FnExpr {
  return b.isArrowFunctionExpression(expr) || b.isFunctionExpression(expr);
}

function hirPatternMatchTopDownCallExprs(
  ht: HirTransform,
  expr: b.CallExpression,
  buf: Array<b.CallExpression>,
  i: number,
) {
  if (!b.isExpression(expr.callee)) return;
  if (b.isIdentifier(expr.callee) && expr.callee.name == ht.importName) {
    buf[0] = expr;
    return;
  }

  if (b.isMemberExpression(expr.callee)) {
    if (b.isCallExpression(expr.callee.object)) {
      buf[i] = expr;
      return hirPatternMatchTopDownCallExprs(
        ht,
        expr.callee.object,
        buf,
        i - 1,
      );
    }
  }

  return;
}

function hirHasPatternMatchRoot(
  ht: HirTransform,
  expr: b.CallExpression,
): number {
  return hirHasPatternMatchRootImpl(ht, expr, 1);
}

function hirHasPatternMatchRootImpl(
  ht: HirTransform,
  expr: b.CallExpression,
  depth: number,
): number {
  if (!b.isExpression(expr.callee)) return 0;
  if (b.isIdentifier(expr.callee) && expr.callee.name == ht.importName)
    return depth;

  if (b.isMemberExpression(expr.callee)) {
    if (b.isCallExpression(expr.callee.object))
      return hirHasPatternMatchRootImpl(ht, expr.callee.object, depth + 1);
  }

  return 0;
}

function isPatternMatchExpr(val: b.Node | null | undefined): val is Expr {
  return b.isExpression(val) || b.isSpreadElement(val);
}

/**
 * See list of patterns here: https://github.com/gvergnaud/ts-pattern/tree/main#patterns
 * */
function hirTransformPatternMatchBranch(
  ht: HirTransform,
  args: b.CallExpression['arguments'],
): PatternMatchBranch {
  if (args.length < 2) {
    throw new Error(`Invalid amount of args: ${args.length}`);
  }
  // 2nd arg can possibly a guard function, see: https://github.com/gvergnaud/ts-pattern/tree/main#pwhen-and-guard-functions
  // But _only_ the 2nd arg, so won't work with multiple patterns.
  //
  // Unfortunately, there's no completely robust way to know at compile time
  // without type information if the 2nd arg is a function. We use a simple
  // heuristic by just checking the AST node type. For example:
  //
  // ```typescript
  // .with(
  //   [{ status: 'loading' }, { type: 'cancel' }],
  //   ([state, event]) => state.startTime + 2000 < Date.now(), // <-- guard is here
  //   () => ({ status: 'idle' })
  // )
  // ```
  //
  // ```typescript
  // match(name)
  //   .with ('text', 'span', 'p', () => 'text')
  //   .with('btn', 'button', () => 'button')
  //   .otherwise(() => name);
  // ```
  if (args.length === 3) {
    if (isFunction(args[1])) {
      const then = args[2];
      if (!b.isExpression(then)) throw new Error(`unsupported: ${then.type}}`);
      if (!b.isExpression(args[0]))
        throw new Error(`unsupported: ${args[0].type}`);
      return {
        patterns: [hirTransformPattern(ht, args[0])],
        guard: args[1],
        then,
      };
    }
  }

  // Everything else is patterns
  const then = args[args.length - 1];
  if (!b.isExpression(then)) throw new Error(`unsupported: ${then.type}}`);
  return {
    patterns: args.slice(0, args.length - 1).map((arg) => {
      if (!b.isExpression(arg)) throw new Error('unimplemented');
      return hirTransformPattern(ht, arg);
    }),
    guard: undefined,
    then,
  };
}

function hirTransformPattern(ht: HirTransform, expr: b.Expression): Pattern {
  if (b.isObjectExpression(expr))
    return hirTransformPatternObjectExpr(ht, expr);

  if (b.isStringLiteral(expr))
    return { type: 'literal', value: { type: 'string', value: expr.value } };

  if (b.isNumericLiteral(expr))
    return { type: 'literal', value: { type: 'number', value: expr.value } };

  if (b.isArrayExpression(expr)) {
    return {
      type: 'array',
      value: expr.elements.map((el) => {
        if (!b.isExpression(el))
          throw new Error(`unimplemented type: ${el?.type || 'null'}`);
        return hirTransformPattern(ht, el);
      }),
    };
  }

  // TODO: fallback to runtime check
  throw new Error(`unimplemented ${expr.type}`);
}

function hirTransformPatternObjectExpr(
  ht: HirTransform,
  objectExpr: b.ObjectExpression,
): Pattern {
  const value: PatternObject = {};
  for (const prop of objectExpr.properties) {
    if (!b.isObjectProperty(prop)) {
      throw new Error(`invalid pattern property type: ${prop.type}`);
    }
    if (!b.isIdentifier(prop.key)) {
      throw new Error(`invalid pattern property key type: ${prop.key.type}`);
    }
    if (!b.isExpression(prop.value)) {
      throw new Error(
        `invalid pattern property value type: ${prop.value.type}`,
      );
    }
    value[prop.key.name] = hirTransformPattern(ht, prop.value);
  }

  return {
    type: 'object',
    value,
  };
}

export type HirCodegenOpts = {
  /**
   * For some reason ts-pattern allows you to pattern match on arbitrary types that are unrelated to the expression being matched upon. As a result, optional chaining `foo?.bar?.baz` is necessary to avoid `property of undefined` errors. This incurs an additional runtime overhead, but you can disable it here.
   * */
  disableOptionalChaining: boolean;
};
type HirCodegen = (
  | {
      kind: 'iife';
    }
  | {
      kind: 'block';
      outVar: b.LVal;
      outLabel: b.Identifier;
      patternOriginalOutVar: b.LVal | undefined;
      type: 'var-decl' | 'pattern-var-decl' | 'assignment';
    }
) & { counter: number } & HirCodegenOpts;

function uniqueIdent(n: number): b.Identifier {
  return b.identifier(`__patsy_temp_${n}`);
}
function hirCodegenUniqueIdent(hc: HirCodegen): b.Identifier {
  return uniqueIdent(hc.counter++);
}

export function hirCodegenInit(
  path: NodePath<b.CallExpression>,
  opts: HirCodegenOpts,
): HirCodegen {
  if (b.isVariableDeclarator(path.parent)) {
    const outVar = path.parent.id;
    if (!b.isLVal(outVar)) throw new Error('unimplemented');

    if (b.isArrayPattern(path.parent.id)) {
      return {
        kind: 'block',
        outVar: uniqueIdent(0),
        outLabel: uniqueIdent(1),
        counter: 2,
        patternOriginalOutVar: outVar,
        type: 'pattern-var-decl',
        ...opts,
      };
    }

    return {
      kind: 'block',
      outVar,
      outLabel: uniqueIdent(0),
      counter: 1,
      patternOriginalOutVar: undefined,
      type: 'var-decl',
      ...opts,
    };
  }

  if (b.isAssignmentExpression(path.parent)) {
    return {
      kind: 'block',
      outVar: path.parent.left,
      outLabel: uniqueIdent(0),
      counter: 1,
      patternOriginalOutVar: undefined,
      type: 'assignment',
      ...opts,
    };
  }

  return { kind: 'iife', counter: 0, ...opts };
}

/**
 * Generates an immediately-invoked function expression for the pattern matching.
 **/
function hirCodegen(
  hc: HirCodegen,
  hir: Hir,
): b.LabeledStatement | b.Expression {
  /**
   * This is the expression passed into ts-pattern's `match(x)` function. Bad name. Sorry.
   * */
  let expr: b.Expression = hir.expr;
  const body: b.Statement[] = [];

  // If the expr to match is not an identifier, check if its expensive to compute.
  // If it is expensive, assign it and cache it to a variable.
  // If inexpensive (foo[0], foo.bar, etc.), just use that expression
  if (!b.isIdentifier(hir.expr) && !isInexpensiveExpr(hir.expr)) {
    expr = hirCodegenUniqueIdent(hc);
    body.push(
      b.variableDeclaration('const', [b.variableDeclarator(expr, hir.expr)]),
    );
  }

  // Generate if statements for each branch
  for (const branch of hir.branches) {
    body.push(hirCodegenBranch(hc, expr, branch));
  }

  // Call otherwise if set:
  if (hir.otherwise !== undefined) {
    // TODO: inline function expressions if trivial?
    body.push(
      ...hirCodegenOutput(
        hc,
        b.callExpression(b.parenthesizedExpression(hir.otherwise), [expr]),
      ),
    );
  } else if (!hir.exhaustive) {
    // If no otherwise and not exhaustive generate error if no match.
    //
    // Basically want to create this:
    // ```typescript
    // let displayedValue;
    // try {
    //   displayedValue = JSON.stringify(<< input expr >>);
    // } catch (e) {
    //   displayedValue = << input expr >>;
    // }

    // throw new Error(
    //   `Pattern matching error: no pattern matches value ${displayedValue}`
    // );
    // ```
    //
    // Create Identifiers
    const displayedValue = b.identifier('__patsy__displayedValue');
    const e = b.identifier('e');

    // Create JSON.stringify(this.input)
    const jsonStrExpr = b.callExpression(
      b.memberExpression(b.identifier('JSON'), b.identifier('stringify')),
      [expr],
    );

    // Create try-catch block
    const tryCatch = b.tryStatement(
      b.blockStatement([
        b.expressionStatement(
          b.assignmentExpression('=', displayedValue, jsonStrExpr),
        ),
      ]),
      b.catchClause(
        e,
        b.blockStatement([
          b.expressionStatement(
            b.assignmentExpression('=', displayedValue, expr),
          ),
        ]),
      ),
    );

    // Create `throw new Error(...)` statement
    const throwError = b.throwStatement(
      b.newExpression(b.identifier('Error'), [
        b.templateLiteral(
          [
            b.templateElement({
              raw: 'Pattern matching error: no pattern matches value ',
              cooked: 'Pattern matching error: no pattern matches value ',
            }),
            b.templateElement({ raw: '', cooked: '' }),
          ],
          [displayedValue],
        ),
      ]),
    );

    // Create `let displayedValue;` statement
    const letDisplayedValue = b.variableDeclaration('let', [
      b.variableDeclarator(displayedValue, null),
    ]);

    body.push(...[letDisplayedValue, tryCatch, throwError]);
  }

  if (hc.kind === 'iife') {
    return b.callExpression(
      b.arrowFunctionExpression([], b.blockStatement(body)),
      [],
    );
  }

  return b.labeledStatement(hc.outLabel, b.blockStatement(body));
}

function hirCodegenBranch(
  hc: HirCodegen,
  expr: Expr,
  branch: PatternMatchBranch,
): b.Statement {
  const patternChecks = branch.patterns.map((pat) =>
    hirCodegenPattern(hc, expr, pat),
  );
  const then = hirCodegenPatternThen(hc, expr, branch.then);
  return b.ifStatement(concatConditionals(patternChecks), then);
}

// TODO: here is where we would also do the captures from P.select()
function hirCodegenPatternThen(
  hc: HirCodegen,
  expr: Expr,
  then: Expr,
): b.BlockStatement {
  // Try to inline function expressions
  if (then.type === 'ArrowFunctionExpression') {
    if (then.params.some((p) => p.type !== 'Identifier')) {
      throw new Error(`only identifier param types supported now`);
    }
    return hirCodegenPatternThenFunction(
      hc,
      expr,
      then.params as unknown as b.Identifier[],
      then.body,
    );
  } else if (then.type === 'FunctionExpression') {
    if (then.params.some((p) => p.type !== 'Identifier')) {
      throw new Error(`only identifier param types supported now`);
    }
    return hirCodegenPatternThenFunction(
      hc,
      expr,
      then.params as unknown as b.Identifier[],
      then.body,
    );
  }

  // Otherwise its a function referenced by an identifier or some other
  // expression that resolves to a function
  return b.blockStatement([
    ...hirCodegenOutput(hc, b.callExpression(then, [expr])),
    // b.returnStatement(b.callExpression(then, [expr]))
  ]);
}

/**
 * When `hc.kind` is "iife", it will emit a return statement
 * When `hc.kind` is "block", it will emit an assignment statement and a break statement
 * */
function hirCodegenOutput(hc: HirCodegen, value: Expr): b.Statement[] {
  switch (hc.kind) {
    case 'iife': {
      return [b.returnStatement(value)];
    }
    case 'block': {
      return [
        b.expressionStatement(b.assignmentExpression('=', hc.outVar, value)),
        b.breakStatement(hc.outLabel),
      ];
    }
  }
}

function hirCodegenPatternThenFunction(
  hc: HirCodegen,
  expr: Expr,
  args: b.Identifier[],
  body: b.BlockStatement | b.Expression,
): b.BlockStatement {
  const block: b.Statement[] = [];
  // Bind the args, should only be one
  if (args.length > 1) {
    throw new Error('unimplemented more than one arg on result function');
  } else if (args.length === 1) {
    block.push(
      b.variableDeclaration('let', [b.variableDeclarator(args[0], expr)]),
    );
  }

  // For arrow expression we can just return the expr
  if (body.type !== 'BlockStatement') {
    block.push(...hirCodegenOutput(hc, body));
    // blocks.push(b.returnStatement(body));
  } else {
    hirCodegenRewriteReturns(hc, body);
    block.push(...body.body);
  }

  return b.blockStatement(block);
}

function hirCodegenRewriteReturns(hc: HirCodegen, body: b.BlockStatement) {
  // iife allow returns
  if (hc.kind === 'iife') return;

  traverse(body, {
    noScope: true,
    ReturnStatement(path) {
      const output = hirCodegenOutput(hc, path.node.argument);
      path.replaceWithMultiple(output);
    },
  });
}

function hirCodegenPattern(
  hc: HirCodegen,
  expr: Expr,
  pattern: Pattern,
): b.Expression {
  switch (pattern.type) {
    case 'literal': {
      return hirCodegenPatternLiteral(expr, pattern.value);
    }
    case 'object': {
      return hirCodegenPatternObject(hc, expr, pattern.value);
    }
    case 'array': {
      return hirCodegenPatternArray(hc, expr, pattern.value);
    }
    case 'wildcard':
    case 'matchfn': {
      throw new Error(`unimplemented pattern: ${pattern.type}`);
    }
  }
}

function hirCodegenMemberExpr(
  hc: HirCodegen,
  object: Parameters<typeof b.memberExpression>[0],
  property: Parameters<typeof b.memberExpression>[1],
) {
  if (!hc.disableOptionalChaining)
    return b.optionalMemberExpression(
      object,
      property as b.Expression,
      false,
      true,
    );
  return b.memberExpression(object, property);
}

function hirCodegenPatternArray(
  hc: HirCodegen,
  expr: Expr,
  arr: PatternArray,
): b.Expression {
  // Generate `Array.isArray(input)`
  const isArrayCall = b.callExpression(
    b.memberExpression(b.identifier('Array'), b.identifier('isArray')),
    [expr],
  );

  // `input.length`
  const inputLength = hirCodegenMemberExpr(hc, expr, b.identifier('length'));

  // Generate `input.length >=`
  const boundsCheck = b.binaryExpression(
    '>=',
    inputLength,
    b.numericLiteral(arr.length),
  );

  // Generate `Array.isArray(input) && input.length >= pattern.length`
  const finalExpression = b.logicalExpression('&&', isArrayCall, boundsCheck);

  const conditionals: Array<b.Expression> = [finalExpression];
  for (let i = 0; i < arr.length; i++) {
    // input[i]
    const arrayAccess = b.memberExpression(expr, b.numericLiteral(i), true);
    // Push input[i] === << codegen'd pattern >>
    conditionals.push(hirCodegenPattern(hc, arrayAccess, arr[i]));
  }
  return concatConditionals(conditionals);
}

function hirCodegenPatternObject(
  hc: HirCodegen,
  expr: Expr,
  obj: PatternObject,
): b.Expression {
  const conditionals: Array<b.Expression> = [];
  for (const [key, pat] of Object.entries(obj)) {
    if (pat.type === 'object') {
      conditionals.push(
        hirCodegenPattern(
          hc,
          hirCodegenMemberExpr(hc, expr, b.identifier(key)),
          pat,
        ),
      );
      continue;
    }

    conditionals.push(
      // b.binaryExpression("===", b.memberExpression(expr, b.identifier(key)), hirCodegenPattern(expr, pat))
      hirCodegenPattern(
        hc,
        hirCodegenMemberExpr(hc, expr, b.identifier(key)),
        pat,
      ),
    );
  }
  return concatConditionals(conditionals);
}

function hirCodegenPatternLiteral(
  expr: Expr,
  lit: PatternLiteral,
): b.Expression {
  return b.binaryExpression('===', expr, patternLiteralToExpr(lit));
}

function patternLiteralToExpr(lit: PatternLiteral): b.Expression {
  switch (lit.type) {
    case 'string': {
      return b.stringLiteral(lit.value);
    }
    case 'number': {
      return b.numericLiteral(lit.value);
    }
  }
}

function concatConditionals(conds: Array<b.Expression>): b.Expression {
  if (conds.length === 1) return conds[0];

  let i = conds.length - 1;
  let out: b.Expression = conds[i];
  i--;

  for (i; i >= 0; i--) {
    const cond = conds[i];
    // out = b.logicalExpression("&&", b.parenthesizedExpression(cond), b.parenthesizedExpression(out))
    out = b.logicalExpression('&&', cond, out);
  }

  return out;
}

// TODO: expressions like arr[0], 'literal', 123, foo.bar
function isInexpensiveExpr(expr: b.Expression): boolean {
  if (b.isIdentifier(expr)) return true;
  return false;
}

export default patsyPlugin;
