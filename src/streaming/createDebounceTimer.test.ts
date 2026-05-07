import { describe, expect, mock, test } from "bun:test";
import { createDebounceTimer, type DispatcherTimer } from "./createDebounceTimer.ts";

interface ScheduledCall {
  delay: number;
  fn: () => void;
}

function makeFakeTimer(): { timer: DispatcherTimer; pending: () => ScheduledCall[]; fire: (id: number) => void; fireAll: () => void } {
  const handlers = new Map<number, ScheduledCall>();
  let nextId = 1;
  return {
    timer: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        handlers.set(id, { delay: ms, fn });
        return id;
      },
      clearTimeout: (handle) => {
        handlers.delete(handle as number);
      },
    },
    pending: () => [...handlers.values()],
    fire: (id) => {
      const entry = handlers.get(id);
      if (!entry) throw new Error(`no pending timer with id ${id}`);
      handlers.delete(id);
      entry.fn();
    },
    fireAll: () => {
      const entries = [...handlers.entries()];
      handlers.clear();
      for (const [, { fn }] of entries) fn();
    },
  };
}

describe("createDebounceTimer", () => {
  test("first schedule arms the underlying timer with the requested delay", () => {
    const onFire = mock(() => {});
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire });
    debouncer.schedule(500);
    expect(fake.pending()).toEqual([{ delay: 500, fn: expect.any(Function) }]);
    expect(onFire).not.toHaveBeenCalled();
  });

  test("schedule calls during a pending window are no-ops", () => {
    const onFire = mock(() => {});
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire });
    debouncer.schedule(500);
    debouncer.schedule(100); // shorter delay — must NOT re-arm
    debouncer.schedule(50);
    expect(fake.pending().length).toBe(1);
    expect(fake.pending()[0]!.delay).toBe(500);
  });

  test("firing clears the slot so subsequent schedule calls re-arm", () => {
    const onFire = mock(() => {});
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire });
    debouncer.schedule(500);
    fake.fireAll();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(debouncer.isPending()).toBe(false);

    debouncer.schedule(200);
    expect(fake.pending().length).toBe(1);
    expect(fake.pending()[0]!.delay).toBe(200);
  });

  test("schedule called from within onFire re-arms cleanly", () => {
    // Simulates the dispatcher pattern: onFire enqueues a flush, the
    // flush's settle path schedules another flush via append. The
    // timer slot must be empty during onFire so the inside re-arm wins.
    const fake = makeFakeTimer();
    let reArmed = false;
    const debouncer = createDebounceTimer({
      timer: fake.timer,
      onFire: () => {
        debouncer.schedule(300);
        reArmed = true;
      },
    });
    debouncer.schedule(500);
    fake.fireAll();
    expect(reArmed).toBe(true);
    expect(fake.pending().length).toBe(1);
    expect(fake.pending()[0]!.delay).toBe(300);
  });

  test("clear cancels a pending callback; idempotent when nothing pending", () => {
    const onFire = mock(() => {});
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire });
    debouncer.schedule(500);
    debouncer.clear();
    expect(fake.pending().length).toBe(0);
    expect(debouncer.isPending()).toBe(false);

    // Idempotent: calling clear when nothing is pending is fine.
    debouncer.clear();
    expect(debouncer.isPending()).toBe(false);

    // After clearing, schedule re-arms normally.
    debouncer.schedule(100);
    expect(fake.pending()[0]!.delay).toBe(100);
  });

  test("clear after fire is a no-op", () => {
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire: () => {} });
    debouncer.schedule(500);
    fake.fireAll();
    debouncer.clear(); // should not throw / over-clear
    expect(debouncer.isPending()).toBe(false);
  });

  test("isPending reflects the current state", () => {
    const fake = makeFakeTimer();
    const debouncer = createDebounceTimer({ timer: fake.timer, onFire: () => {} });
    expect(debouncer.isPending()).toBe(false);
    debouncer.schedule(500);
    expect(debouncer.isPending()).toBe(true);
    fake.fireAll();
    expect(debouncer.isPending()).toBe(false);
  });
});
