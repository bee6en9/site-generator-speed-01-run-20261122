// Faster drop-in for makefun-site 1.0.0 (v3): the harness runs `node main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// v3 compiles each template once per case into a plain function (the template
// JIT in solve.js: array-push output, compile-time path resolution, one
// mutable scope per render) instead of walking an op array per render. Set
// USE_JIT false in solve.js to fall back to the interpreter.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, and its optimising compiler off, set before
// solve.js is imported so all of its work runs under them (the rules: the
// house baseline runs with --no-incremental-marking, and an entry may tune
// V8's flags the same way). --no-opt matters here because every graded run
// is a fresh, single-shot process: the optimising compiler's background
// threads cost more CPU than the optimisation saves on one cold run, while
// the work itself is already pushed into native string/regex builtins.
setFlagsFromString('--no-opt --no-incremental-marking --max-semi-space-size=64');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Each case is answered alone, in order: run() keeps no state between cases,
// and the build reads no clock, no environment and no randomness, so two runs
// write byte-identical answers. The answers array holds one answer per case,
// in the cases' order, and is written as one JSON file.
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
