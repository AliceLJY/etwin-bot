import { describe, expect, test } from "bun:test";
import { createNonOverlappingTickRunner } from "./self-loop.js";


describe("createNonOverlappingTickRunner", () => {
  test("skips an overlapping timer tick and allows the next one after completion", async () => {
    let releaseFirst;
    let calls = 0;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const runTick = createNonOverlappingTickRunner(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
    });

    const first = runTick();
    await Promise.resolve();
    expect(await runTick()).toBe(false);
    expect(calls).toBe(1);

    releaseFirst();
    expect(await first).toBe(true);
    expect(await runTick()).toBe(true);
    expect(calls).toBe(2);
  });

  test("releases the guard after a failed tick", async () => {
    let calls = 0;
    const errors = [];
    const runTick = createNonOverlappingTickRunner(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first failed");
    }, (error) => errors.push(error.message));

    expect(await runTick()).toBe(false);
    expect(await runTick()).toBe(true);
    expect(errors).toEqual(["first failed"]);
  });
});
