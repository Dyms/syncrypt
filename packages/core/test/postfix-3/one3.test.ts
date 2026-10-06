// Replays one fuzz3 counterexample: CE='[...]' npx vitest run .../review3/one3.test.ts
import { expect, it } from "vitest";
import { runScenario, type Action } from "./fuzz3.test.js";
it.skipIf(process.env.CE === undefined)("replay counterexample", async () => {
  const actions = JSON.parse(process.env.CE ?? "[]") as Action[];
  expect(await runScenario(actions, true)).toEqual([]);
});
