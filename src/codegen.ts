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
  PatternSelect,
  PatternSelectNamed,
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
  branchCtx: BranchCtx;
} & HirCodegenOpts;

type BranchCtx = {
  selections?: BranchCtxSelections;
};

type BranchCtxSelections =
  | { type: 'anonymous'; expr: b.Expression }
  | {
      type: 'named';
      selections: Array<[pattern: PatternSelectNamed, expr: b.Expression]>;
    };

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
        ...opts,
        kind: 'block',
        outVar: uniqueIdent(0),
        outLabel: uniqueIdent(1),
        counter: 2,
        patternOriginalOutVar: outVar,
        type: 'pattern-var-decl',
        branchCtx: {},
      };
    }

    return {
      ...opts,
      kind: 'block',
      outVar,
      outLabel: uniqueIdent(0),
      counter: 1,
      patternOriginalOutVar: undefined,
      type: 'var-decl',
      branchCtx: {},
    };
  }

  if (b.isAssignmentExpression(path.parent)) {
    return {
      ...opts,
      kind: 'block',
      outVar: path.parent.left,
      outLabel: uniqueIdent(0),
      counter: 1,
      patternOriginalOutVar: undefined,
      type: 'assignment',
      branchCtx: {},
    };
  }

  return { ...opts, kind: 'iife', counter: 0, branchCtx: {} };
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
  hc.branchCtx = {};
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
  // expression that resolves to a function, so call it with the args:
  // - if no branch selections => just the match expr
  // - if selectoins => the selection / selection object, then the match expr
  return b.blockStatement([
    ...hirCodegenOutput(
      hc,
      b.callExpression(
        then,
        hc.branchCtx.selections !== undefined
          ? [hirCodegenConstructSelectionExpr(hc.branchCtx.selections), expr]
          : [expr],
      ),
    ),
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

/**
 * Returns an expression that represents the selection of the branch:
 * - anonymous selection => the expression referencing the match expr
 * - named selection => an object literal with keys being the names, and values being referencing the match expr
 *
 * Anonymous selection:
 * ```typescript
 * match(foo).with({ type: 'bar', name: P.select() }, (val) => console.log(val))
 * ```
 * The expression should be `foo.name`
 *
 *
 * Named selection:
 * ```typescript
 * match(foo).with({ type: 'bar', name: P.select('name'), age: P.select('age') }, (val) => console.log(val))
 * ```
 * The expression should be `{ name: foo.name, age: foo.age }`
 **/
function hirCodegenConstructSelectionExpr(
  selections: BranchCtxSelections,
): b.Expression {
  if (selections.type === 'anonymous') return selections.expr;

  const properties = selections.selections.map(([pattern, expr]) =>
    b.objectProperty(pattern.name, expr, true),
  );

  return b.objectExpression(properties);
}

function hirCodegenPatternThenFunction(
  hc: HirCodegen,
  expr: Expr,
  args: b.Identifier[],
  body: b.BlockStatement | b.Expression,
): b.BlockStatement {
  const block: b.Statement[] = [];
  // Bind the args to the handler
  if (args.length > 1 && hc.branchCtx.selections === undefined) {
    throw new Error('unimplemented more than one arg on result function');
  } else if (args.length === 1) {
    block.push(
      b.variableDeclaration('let', [
        b.variableDeclarator(
          args[0]!,
          hc.branchCtx.selections === undefined
            ? expr
            : hirCodegenConstructSelectionExpr(hc.branchCtx.selections),
        ),
      ]),
    );
  } else if (args.length === 2 && hc.branchCtx.selections !== undefined) {
    block.push(
      // The first arg should be bound to the selection
      b.variableDeclaration('let', [
        b.variableDeclarator(
          args[0]!,
          hirCodegenConstructSelectionExpr(hc.branchCtx.selections),
        ),
      ]),
      // the second arg is the matched expression
      b.variableDeclaration('let', [b.variableDeclarator(args[1]!, expr)]),
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
      const output = hirCodegenOutput(
        hc,
        path.node.argument || b.identifier('undefined'),
      );
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
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean': {
      return hirCodegenPatternSimpleTypeof(hc, expr, pattern.type);
    }
    case 'nullish':
    case 'symbol':
    case 'wildcard':
    case '_array':
    case 'set':
    case 'map':
    case 'when':
    case 'not': {
      throw new Error(`unimplemented pattern: ${pattern.type}`);
    }
    case 'select': {
      return hirCodegenPatternSelect(hc, expr, pattern.value);
    }
  }
}

function hirCodegenPatternSimpleTypeof(
  hc: HirCodegen,
  expr: b.Expression,
  type: 'string' | 'number' | 'bigint' | 'boolean',
): b.Expression {
  return b.binaryExpression(
    '===',
    b.unaryExpression('typeof', expr, true),
    b.stringLiteral(type),
  );
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
    conditionals.push(hirCodegenPattern(hc, arrayAccess, arr[i]!));
  }
  return concatConditionals(conditionals);
}

function hirCodegenPatternSelect(
  hc: HirCodegen,
  expr: Expr,
  select: PatternSelect,
): b.Expression {
  if (hc.branchCtx.selections !== undefined) {
    if (hc.branchCtx.selections.type === 'anonymous') {
      throw new Error(
        'Cannot have more than one anonymous `P.select()` in a single pattern match branch',
      );
    }
    if (select.type !== 'named')
      throw new Error(
        'Cannot mix anonymous and named `P.select()` in a single pattern match branch',
      );

    hc.branchCtx.selections.selections.push([select, expr]);
  } else {
    if (select.type === 'anonymous') {
      hc.branchCtx.selections = { type: 'anonymous', expr };
    } else {
      hc.branchCtx.selections = { type: 'named', selections: [[select, expr]] };
    }
  }

  if (select.subpattern !== undefined)
    return hirCodegenPattern(hc, expr, select.subpattern);

  return b.booleanLiteral(true);
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
    case 'boolean': {
      return b.identifier('undefined');
    }
    case 'bigint': {
      return b.bigIntLiteral(lit.value);
    }
    case 'undefined': {
      return b.identifier('undefined');
    }
    case 'null': {
      return b.nullLiteral();
    }
    case 'nan': {
      return b.identifier('NaN');
    }
  }
}

/**
 * Turn an array of conditionals (expressions that return a boolean) into a single expression chained by multiple '&&'
 **/
function concatConditionals(conds_: Array<b.Expression>): b.Expression {
  // `true` is redundant so we can get rid of it
  const conds = conds_.filter(
    (cond) => !(b.isBooleanLiteral(cond) && cond.value === true),
  );
  if (conds.length === 0)
    throw new Error('unreachable: conds array should be non-empty');
  if (conds.length === 1) return conds[0]!;

  let i = conds.length - 1;
  let out: b.Expression = conds[i]!;
  i--;

  for (i; i >= 0; i--) {
    const cond = conds[i]!;
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
