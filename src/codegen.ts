import { NodePath } from '@babel/core';
import * as b from '@babel/types';
import {
  Expr,
  Hir,
  Pattern,
  PatternArray,
  PatternLiteral,
  PatternMatchBranch,
  PatternObject,
} from './hir';
import traverse from '@babel/traverse';

export type HirCodegenOpts = {
  /**
   * For some reason ts-pattern allows you to pattern match on arbitrary types that are unrelated to the expression being matched upon. As a result, optional chaining `foo?.bar?.baz` is necessary to avoid `property of undefined` errors. This incurs an additional runtime overhead, but you can disable it here.
   * */
  disableOptionalChaining: boolean;
};
export type HirCodegen = (
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
) & {
  // monotonically increasing id used for generating unique identifiers
  counter: number;
} & HirCodegenOpts;

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
export function hirCodegen(
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

/**
 * Turn an array of conditionals (expressions that return a boolean) into a single expression chained by multiple '&&'
 **/
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
