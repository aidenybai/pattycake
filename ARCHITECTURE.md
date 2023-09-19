# Architecture

The compiler has three primary steps:

1. Determine is `match` is imported from `ts-pattern` and the name the user assigns to it
2. HIR step: Visit each CallExpression, and try to convert it to a high-level intermediate representation (HIR)
3. Codegen step: Codegen the HIR back into JS/TS

## HIR step

We create a high-level intermediate representation of the source's AST. The HIR is friendlier to work with when executing the codegen step, because it clearly encodes information important for codegen like pattern match branches, etc.

Here is a rough example of what it looks like:

```typescript
export type PatternMatch = {
  // the expression being matched uppon
  expr: Expr;
  branches: Array<Branch>;
  otherwise: Expr | undefined;
  exhaustive: boolean;
};

export type Branch = {
  patterns: Array<Pattern>;
  guard: FnExpr | undefined;
  then: b.Expression;
};
```

This is far more amenable to work with than Babel's normal JS/TS AST, which would represent a ts-pattern match as an extremely unwieldly nested tree of CallExpressions and MemberExpressions (see [here](https://astexplorer.net/#/gist/9822811045bb4224053b95da23fbd0fd/7b8f40e7269cc22a8f470691303ee8b3c7cb8de9) for an example).

## Codegen

The codegen step is responsible for turning the Hir back into Babel's AST. A simplified overview is that its really just a for-loop over the branches of the Hir. It turns each branch into an if statement. It will also generate code for the `otherwise` case if provided, and also a runtime exhaustiveness check if necessary.

Normally, it wraps the entire chain of if statements, otherwise case, and exhaustiveness check in an immediately-invoked function expression. But this has a performance cost, so when possible, it will try to avoid this and instead generate a block.
