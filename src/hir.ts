import * as b from '@babel/types';

export type Hir = PatternMatch;

export type PatternMatch = {
  expr: Expr;
  branches: Array<PatternMatchBranch>;
  otherwise: Expr | undefined;
  exhaustive: boolean;
};

export type Expr = b.Expression;
export type FnExpr = b.ArrowFunctionExpression | b.FunctionExpression;

export type PatternMatchBranch = {
  patterns: Array<Pattern>;
  guard: FnExpr | undefined;
  then: b.Expression;
};

export type Pattern =
  | {
      type: 'literal';
      value: PatternLiteral;
    }
  | { type: 'object'; value: PatternObject }
  | { type: 'array'; value: PatternArray }
  | { type: 'wildcard'; value: unknown }
  | { type: 'matchfn'; value: unknown };

export type PatternLiteral =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number };
export type PatternObject = Record<string, Pattern>;
export type PatternArray = Array<Pattern>;

/**
 * Extra state to be stored when transforming to Hir
 * */
export type HirTransform = {
  importName: string;
};

export function hirFromCallExpr(
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

  return hirFromCallExprImpl(ht, buf);
}

function hirFromCallExprImpl(
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
        const branch = transformToPatternMatchBranch(ht, callExpr.arguments);
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

/**
 *  The AST of a ts-pattern match expression is a nested
 *  tree of CallExpressions, which is cumbersome and also upside-down for our purposes. This
 *  functions converts this upside down tree into a flat array in the correct
 *  order (the first CallExpression represents the initial `match()` call, the
 *  next represents the first `.with()` call, etc.)
 **/
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
function transformToPatternMatchBranch(
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
        patterns: [transformToPattern(ht, args[0])],
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
      return transformToPattern(ht, arg);
    }),
    guard: undefined,
    then,
  };
}

function transformToPattern(ht: HirTransform, expr: b.Expression): Pattern {
  if (b.isObjectExpression(expr)) return transformToPatternObjExpr(ht, expr);

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
        return transformToPattern(ht, el);
      }),
    };
  }

  // TODO: fallback to runtime check
  throw new Error(`unimplemented ${expr.type}`);
}

function transformToPatternObjExpr(
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
    value[prop.key.name] = transformToPattern(ht, prop.value);
  }

  return {
    type: 'object',
    value,
  };
}
