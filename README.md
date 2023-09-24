# pattycake

An optimizing compiler for [ts-pattern](https://github.com/gvergnaud/ts-pattern) that lets you have your cake (expressive pattern matching), and eat it too (zero runtime overhead).

## About

`ts-pattern` is a great library that brings the ergonomics of pattern matching from languages like Rust and OCaml to Typescript, but at the cost of being orders of magnitude slower.

`pattycake` compiles ts-pattern's `match()` expressions into an optimized chain of if statements to completely eliminate that cost. In our initial benchmarks, it outperforms `ts-pattern` by usually ~36-66x.

In essence, `pattycake` converts a `ts-pattern` `match()` expression like this:

```typescript
let html = match(result)
  .with(
    { type: 'error', error: { foo: [1, 2] }, nice: '' },
    () => '<p>Oups! An error occured</p>',
  )
  .with({ type: 'ok', data: { type: 'text' } }, function (data) {
    return '<p>420</p>';
  })
  .with(
    { type: 'ok', data: { type: 'img', src: 'hi' } },
    (src) => `<img src=${src} />`,
  )
  .otherwise(() => 'idk bro');
```

Into this:

```typescript
let html;
out: {
  if (
    result.type === 'error' &&
    Array.isArray(result.error.foo) &&
    result.error.foo.length >= 2 &&
    result.error.foo[0] === 1 &&
    result.error.foo[1] === 2
  ) {
    html = '<p>Oups! An error occured</p>';
    break out;
  }
  if (result.type === 'ok' && result.data.type === 'text') {
    let data = result;
    html = '<p>420</p>';
    break out;
  }
  if (
    result.type === 'ok' &&
    result.data.type === 'img' &&
    result.data.src === 'hi'
  ) {
    let src = result;
    html = `<img src=${src} />`;
    break out;
  }
  html = 'idk bro';
  break out;
}
```

## Feature parity with ts-pattern

- [x] [Literal patterns](https://github.com/gvergnaud/ts-pattern#literals)
  - [x] string
  - [x] number
  - [x] booleans
  - [x] bigint
  - [x] undefined
  - [x] null
  - [x] NaN
- [x] [Object patterns](https://github.com/gvergnaud/ts-pattern#objects)
- [x] [Array/tuples patterns](https://github.com/gvergnaud/ts-pattern#tuples-arrays)
- [ ] `.when()`
- [ ] [Wildcards](https://github.com/gvergnaud/ts-pattern#wildcards) patterns
  - [x] `P._`
  - [x] `P.string`
  - [x] `P.number`
- [ ] Special matcher functions
  - [ ] `P.not`
  - [ ] `P.when`
  - [x] `P.select`
  - [ ] `P.array`
  - [ ] `P.map`
  - [ ] `P.set`

## Notes

### Fallback / compatibility with `ts-pattern`

If `pattycake` is unable to optimize a `match()` expression, it will fallback to using `ts-pattern`. This is enabled right now because we don't support the full feature set of ts-pattern.

### Inlining handlers

One performance problem of `ts-pattern`'s are handler functions:

```typescript
match(foo)
  .with({ foo: 'bar', () => /* this is a handler function */)
  .with({ foo: 'baz', () => /* another one */)
```

Function calls usually have an overhead, and a lot of the time these handlers are small little functions (e.g. `(result) => result + 1`) which can be much faster if just directly inlined in the code.

Additionally, a `match()` with many branches means creating a lot of function objects in the runtime.

The JIT-compiler and optimizer in JS engines can do inlining of functions, but in general with JIT you need to run your code several times or it to determine what to optimize.

So when possible, `pattycake` will try to inline function expression (anonymous functions / arrow functions) handlers directly into the code if it is small.

### IIFEs

When possible, `pattycake` will try to generate a block of code (like in the example above). But there are times where this is not possible without breaking the semantics of source code.

## Roadmap

Right now, the goal is to support the full feature set of ts-pattern, or at least a sufficient amount. After, the ideal is
that we compile pattern matching expressions into code that would be faster than what you would write by hand.
