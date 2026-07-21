import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCommandThrottle, type ThrottleClock } from "./throttle.ts";

/**
 * The sliding window, on virtual time.
 *
 * This is the only part of the TeamSpeak transport that can be tested without a
 * live server (ARCHITECTURE §9), and it is worth testing because getting the
 * arithmetic wrong is silent in both directions: too slow and every pass drags,
 * too fast and the flood comes back looking exactly like it did before.
 */

interface FakeClock extends ThrottleClock {
  slept: number[];
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
    slept,
  };
}

/** Let every queued microtask run. The throttle chains on promises, not timers. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function throttleOn(clock: FakeClock, maxCommands = 2, windowMs = 3_000) {
  return createCommandThrottle({ maxCommands, windowMs, clock });
}

Deno.test("a burst up to the limit is not delayed", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  await throttle.run(() => Promise.resolve("a"));
  await throttle.run(() => Promise.resolve("b"));

  assertEquals(clock.slept, []);
  assertEquals(throttle.stats().commands, 2);
  assertEquals(throttle.stats().waitedMs, 0);
});

Deno.test("the command over the limit waits for the oldest to leave the window", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  await throttle.run(() => Promise.resolve("a"));
  await throttle.run(() => Promise.resolve("b"));
  await throttle.run(() => Promise.resolve("c"));

  // Both earlier commands were sent at t=0, so the window frees at t=3000.
  assertEquals(clock.slept, [3_000]);
  assertEquals(throttle.stats().waitedMs, 3_000);
  assertEquals(throttle.stats().commands, 3);
});

Deno.test("time passing outside the throttle counts: no wait once the window has drained", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  await throttle.run(() => Promise.resolve("a"));
  await throttle.run(() => Promise.resolve("b"));
  clock.advance(3_000);
  await throttle.run(() => Promise.resolve("c"));

  assertEquals(clock.slept, []);
});

Deno.test("commands are serialized: the next one waits for the previous to settle", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  let releaseFirst!: (value: string) => void;
  const first = throttle.run(() =>
    new Promise<string>((resolve) => {
      releaseFirst = resolve;
    })
  );

  let secondStarted = false;
  const second = throttle.run(() => {
    secondStarted = true;
    return Promise.resolve("b");
  });

  await settle();
  // The library keeps one command in flight; so do we, so nothing can pile up
  // behind a command that is stuck in the library's own 524 re-send loop.
  assertEquals(secondStarted, false);

  releaseFirst("a");
  assertEquals(await first, "a");
  assertEquals(await second, "b");
  assertEquals(secondStarted, true);
});

Deno.test("a rejected command does not poison the queue behind it", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  await assertRejects(
    () => throttle.run(() => Promise.reject(new Error("teamspeak said no"))),
    Error,
    "teamspeak said no",
  );

  assertEquals(
    await throttle.run(() => Promise.resolve("still works")),
    "still works",
  );
});

Deno.test("charge() spends budget without waiting, and the next gated command pays for it", async () => {
  const clock = fakeClock();
  const throttle = throttleOn(clock);

  // What the priorized handshake commands do: they cannot be deferred, so they
  // bypass the queue, but they still occupy TeamSpeak's flood budget.
  throttle.charge();
  throttle.charge();
  assertEquals(clock.slept, []);

  await throttle.run(() => Promise.resolve("a"));

  assertEquals(clock.slept, [3_000]);
  assertEquals(throttle.stats().commands, 3);
});

Deno.test("a maxCommands under 1 is refused rather than silently disabling the throttle", () => {
  assertThrows(
    () => createCommandThrottle({ maxCommands: 0 }),
    Error,
    "maxCommands must be a whole number >= 1",
  );
});
