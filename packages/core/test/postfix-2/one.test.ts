// Replays one fuzz counterexample: CE='[...]' npx vitest run .../one.test.ts
import { expect, it } from "vitest";
import { runScenario, type Action } from "./fuzz-loss.test.js";
it.skipIf(process.env.CE === undefined)("replay counterexample", async () => {
  const actions = JSON.parse(process.env.CE ?? "[]") as Action[];
  expect(await runScenario(actions, true)).toEqual([]);
});
