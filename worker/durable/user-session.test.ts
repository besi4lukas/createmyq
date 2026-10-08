/**
 * UserSession (STM-9 state machine, STM-10 flush) against a fake storage.
 * The Postgres write is replaced by a controllable function: what is tested is
 * the object's own logic (what it stores, when it deletes, how it retries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeState } from "../testing/fake-state";
import { UserSession } from "./user-session";
import { writeFinishedSession } from "../quiz/flush";
import type { AssembledQuestion } from "../quiz/assemble";

vi.mock("../db/client", () => ({ withDb: vi.fn((_env: unknown, _ctx: unknown, fn: (db: unknown) => unknown) => fn({})) }));
vi.mock("../quiz/flush", () => ({ writeFinishedSession: vi.fn() }));
const write = vi.mocked(writeFinishedSession);

const q = (n: number, answer = 1): AssembledQuestion => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  format: "multiple_choice",
  difficulty: "beginner",
  topic: `topic ${n}`,
  prompt: `prompt ${n}`,
  explanation: `because ${n}`,
  payload: { options: ["A", "B", "C", "D"].map((o) => `${o}${n}`), answer: `${["A", "B", "C", "D"][answer]}${n}` },
});
const QUESTIONS = [q(1, 0), q(2, 1), q(3, 2)];
const input = (mode: "practice" | "exam" = "practice") => ({
  kind: "category" as const,
  userId: "user-1",
  categoryId: "cat-1",
  category: "system-design",
  difficulty: "beginner",
  mode,
  length: 5,
  questions: QUESTIONS,
});

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

async function make(state = fakeState(), env: Partial<Env> = {}) {
  const obj = new UserSession(state.ctx, env as Env);
  await vi.advanceTimersByTimeAsync(0); // let the constructor's blockConcurrencyWhile settle
  return { obj, state };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  write.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe("start", () => {
  it("stores the full snapshot but returns no answers, explanations or keys", async () => {
    const { obj, state } = await make();
    const { started, quiz } = obj.start(input());
    expect(started).toBe(true);
    expect(quiz).toMatchObject({ category: "system-design", mode: "practice", length: 5, questionCount: 3, currentIndex: 0, answers: [] });
    expect(quiz.questions[1]).toEqual({
      index: 1,
      id: QUESTIONS[1]!.id,
      format: "multiple_choice",
      difficulty: "beginner",
      topic: "topic 2",
      prompt: "prompt 2",
      options: ["A2", "B2", "C2", "D2"],
    });
    const stored = state.data.get("quiz:active") as { idempotencyKey: string; userId: string };
    const wire = JSON.stringify(quiz);
    expect(wire).not.toContain("because");
    expect(wire).not.toContain(stored.idempotencyKey);
    expect(wire).not.toContain("user-1");
    expect(stored.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never replaces a quiz in progress", async () => {
    const { obj } = await make();
    const first = obj.start(input()).quiz;
    const again = obj.start(input("exam"));
    expect(again.started).toBe(false);
    expect(again.quiz.quizId).toBe(first.quizId);
    expect(again.quiz.mode).toBe("practice");
  });
});

describe("answer", () => {
  it("rejects a missing or different quiz", async () => {
    const { obj } = await make();
    expect(obj.answer("nope", 0, 0)).toEqual({ ok: false, code: "no_quiz" });
    obj.start(input());
    expect(obj.answer("other", 0, 0)).toEqual({ ok: false, code: "not_current_quiz" });
  });

  it("grades in order, Practice reveals verdict and explanation", async () => {
    const { obj } = await make();
    const { quizId } = obj.start(input()).quiz;
    expect(obj.answer(quizId, 0, 0)).toEqual({
      ok: true,
      duplicate: false,
      answer: { index: 0, option: 0, choice: "A1", correct: true, correctAnswer: "A1", explanation: "because 1" },
      currentIndex: 1,
      done: false,
    });
    expect(obj.answer(quizId, 1, 3)).toMatchObject({ ok: true, answer: { correct: false, correctAnswer: "B2" } });
  });

  it("is idempotent by index: a repeat returns the stored answer unchanged", async () => {
    const { obj } = await make();
    const { quizId } = obj.start(input()).quiz;
    obj.answer(quizId, 0, 2);
    expect(obj.answer(quizId, 0, 0)).toMatchObject({ ok: true, duplicate: true, answer: { option: 2, choice: "C1" }, currentIndex: 1 });
  });

  it("rejects skipping ahead, answering past the end and a bad option", async () => {
    const { obj } = await make();
    const { quizId } = obj.start(input()).quiz;
    expect(obj.answer(quizId, 2, 0)).toEqual({ ok: false, code: "out_of_order", currentIndex: 0 });
    expect(obj.answer(quizId, 0, 4)).toEqual({ ok: false, code: "bad_option", currentIndex: 0 });
    obj.answer(quizId, 0, 0);
    obj.answer(quizId, 1, 0);
    expect(obj.answer(quizId, 2, 0)).toMatchObject({ ok: true, currentIndex: 3, done: true });
    expect(obj.answer(quizId, 3, 0)).toEqual({ ok: false, code: "out_of_order", currentIndex: 3 });
  });

  it("Exam returns only the choice, mid-quiz and on resume", async () => {
    const { obj, state } = await make();
    const { quizId } = obj.start(input("exam")).quiz;
    expect(obj.answer(quizId, 0, 1)).toEqual({
      ok: true,
      duplicate: false,
      answer: { index: 0, option: 1, choice: "B1" },
      currentIndex: 1,
      done: false,
    });
    const { obj: again } = await make(state); // a new instance over the same storage: resume
    expect(again.getActive()?.answers).toEqual([{ index: 0, option: 1, choice: "B1" }]);
    expect(again.getActive()?.currentIndex).toBe(1);
  });
});

describe("finish", () => {
  it("scores, moves the quiz to quiz:done and sets the alarm in one turn", async () => {
    const { obj, state } = await make();
    const { quizId } = obj.start(input("exam")).quiz;
    obj.answer(quizId, 0, 0); // right
    obj.answer(quizId, 1, 0); // wrong
    const out = obj.finish(quizId);
    expect(state.data.has("quiz:active")).toBe(false);
    expect(state.data.get(`quiz:done:${quizId}`)).toMatchObject({ quizId, score: 1, finishedAt: new Date(NOW).toISOString() });
    expect(state.getAlarm()).toBe(NOW + 5_000);
    expect(out).toMatchObject({ ok: true, alreadyFinished: false, result: { score: 1, questionCount: 3, answered: 2 } });
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.review[1]).toMatchObject({ option: 0, choice: "A2", correct: false, correctAnswer: "B2", explanation: "because 2" });
    expect(out.result.review[2]).toMatchObject({ option: null, choice: null, correct: false, correctAnswer: "C3" });
    expect(JSON.stringify(out)).not.toContain((state.data.get(`quiz:done:${quizId}`) as { idempotencyKey: string }).idempotencyKey);
  });

  it("a repeated finish returns the stored result and never touches a newer quiz", async () => {
    const { obj } = await make();
    const { quizId } = obj.start(input()).quiz;
    const first = obj.finish(quizId);
    const next = obj.start(input()).quiz;
    const again = obj.finish(quizId);
    expect(again).toMatchObject({ ok: true, alreadyFinished: true });
    if (!again.ok || !first.ok) throw new Error("unreachable");
    expect(again.result).toEqual(first.result);
    expect(obj.getActive()?.quizId).toBe(next.quizId);
    expect(obj.finish("unknown")).toEqual({ ok: false, code: "no_quiz" });
  });

  it("after the flush, a retried finish still gets its result (quiz:last)", async () => {
    write.mockResolvedValue(true);
    const { obj, state } = await make();
    const { quizId } = obj.start(input()).quiz;
    obj.finish(quizId);
    expect(await obj.flush(quizId)).toBe(true);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(false);
    expect(obj.finish(quizId)).toMatchObject({ ok: true, alreadyFinished: true, result: { quizId } });
  });
});

describe("flush (STM-10)", () => {
  async function finished(state = fakeState()) {
    const made = await make(state);
    const { quizId } = made.obj.start(input()).quiz;
    made.obj.answer(quizId, 0, 0);
    made.obj.finish(quizId);
    return { ...made, quizId };
  }

  it("writes with the stored quiz and user, and deletes only after the write resolves", async () => {
    let commit!: (v: boolean) => void;
    write.mockReturnValue(new Promise<boolean>((r) => (commit = r)));
    const { obj, state, quizId } = await finished();
    const done = obj.flush(quizId);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![1]).toBe("user-1");
    expect(write.mock.calls[0]![2]).toMatchObject({ quizId, score: 1 });
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(true); // not yet committed
    commit(true);
    expect(await done).toBe(true);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(false);
    expect(state.data.get("quiz:last")).toMatchObject({ quizId });
  });

  it("keeps the entry when the write fails", async () => {
    write.mockRejectedValue(new Error("boom"));
    const { obj, state, quizId } = await finished();
    expect(await obj.flush(quizId)).toBe(false);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"session_flush_failed"'));
  });

  it("is single flight: concurrent callers share one write", async () => {
    write.mockResolvedValue(true);
    const { obj, quizId } = await finished();
    const [a, b] = [obj.flush(quizId), obj.flush(quizId)];
    expect(a).toBe(b);
    expect(await a).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("an unknown or already flushed quiz is a no-op success", async () => {
    const { obj } = await make();
    expect(await obj.flush("gone")).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("gives up an attempt after 20 s and keeps the entry", async () => {
    write.mockReturnValue(new Promise<boolean>(() => {}));
    const { obj, state, quizId } = await finished();
    let result: boolean | undefined;
    void obj.flush(quizId).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(true);
  });

  it("falls back to the object's name for an STM-9-era entry without userId", async () => {
    write.mockResolvedValue(true);
    const state = fakeState("legacy-user");
    const { obj, quizId } = await finished(state);
    const entry = state.data.get(`quiz:done:${quizId}`) as Record<string, unknown>;
    delete entry.userId;
    expect(await obj.flush(quizId)).toBe(true);
    expect(write.mock.calls[0]![1]).toBe("legacy-user");
  });
});

describe("alarm (STM-10)", () => {
  it("backs off 5 s × 2ⁿ capped at 10 min, forever, and logs STUCK from the 10th pass", async () => {
    write.mockRejectedValue(new Error("down"));
    const { obj, state } = await make();
    const { quizId } = obj.start(input()).quiz;
    obj.finish(quizId);
    const delays: number[] = [];
    for (let pass = 1; pass <= 12; pass++) {
      state.setAlarm(null);
      await obj.alarm();
      delays.push(state.getAlarm()! - Date.now());
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600, 600, 600, 600].map((s) => s * 1000));
    expect(state.data.get("flush:retries")).toBe(12);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(true);
    const stuck = vi.mocked(console.error).mock.calls.filter(([m]) => String(m).includes("session_flush_STUCK"));
    expect(stuck).toHaveLength(3); // passes 10, 11, 12
    const retry = vi.mocked(console.warn).mock.calls.filter(([m]) => String(m).includes("session_flush_retry_scheduled"));
    expect(retry).toHaveLength(9);
  });

  it("clears the retry count and stops once everything landed", async () => {
    write.mockRejectedValueOnce(new Error("down")).mockResolvedValue(true);
    const { obj, state } = await make();
    const { quizId } = obj.start(input()).quiz;
    obj.finish(quizId);
    state.setAlarm(null);
    await obj.alarm();
    expect(state.data.get("flush:retries")).toBe(1);
    state.setAlarm(null);
    await obj.alarm();
    expect(state.data.has("flush:retries")).toBe(false);
    expect(state.data.has(`quiz:done:${quizId}`)).toBe(false);
    expect(state.getAlarm()).toBeNull();
  });

  it("flushes every entry independently and keeps an earlier alarm", async () => {
    const { obj, state } = await make();
    const a = obj.start(input()).quiz.quizId;
    obj.finish(a);
    const b = obj.start(input()).quiz.quizId;
    obj.finish(b);
    write.mockImplementation(async (_db, _user, quiz) => {
      if (quiz.quizId === a) throw new Error("bad entry");
      return true;
    });
    state.setAlarm(Date.now() + 1_000); // earlier than the 5 s backoff
    await obj.alarm();
    expect(state.data.has(`quiz:done:${a}`)).toBe(true);
    expect(state.data.has(`quiz:done:${b}`)).toBe(false);
    expect(state.getAlarm()).toBe(Date.now() + 1_000);
  });

  it("the constructor re-arms an alarm for unflushed entries with none set", async () => {
    const state = fakeState();
    state.data.set("quiz:done:x", { quizId: "x" });
    await make(state);
    expect(state.getAlarm()).toBe(NOW);

    const armed = fakeState();
    armed.data.set("quiz:done:y", { quizId: "y" });
    armed.setAlarm(NOW + 60_000);
    await make(armed);
    expect(armed.getAlarm()).toBe(NOW + 60_000);
  });
});

describe("prefs", () => {
  it("defaults, merges a patch and survives bad stored data", async () => {
    const { obj, state } = await make();
    expect(obj.getPrefs()).toEqual({ defaultDifficulty: "beginner", defaultMode: "practice", defaultLength: 10, formats: ["multiple_choice"] });
    expect(obj.setPrefs({ defaultLength: 20, defaultMode: "exam" })).toEqual({
      defaultDifficulty: "beginner",
      defaultMode: "exam",
      defaultLength: 20,
      formats: ["multiple_choice"],
    });
    expect(obj.getPrefs().defaultLength).toBe(20);
    state.data.set("prefs", { defaultLength: 7 });
    expect(obj.getPrefs().defaultLength).toBe(10);
  });

  it("rejects an invalid patch", async () => {
    const { obj } = await make();
    expect(() => obj.setPrefs({ formats: ["multiple_choice", "multiple_choice"] })).toThrow();
    expect(() => obj.setPrefs({ defaultLength: 7 } as never)).toThrow();
  });
});

describe("daily generation cap (STM-24)", () => {
  // NOW is 2026-09-30T12:00Z: 13:00 in London (BST), so the London day ends at 23:00Z.
  const LONDON_RESET = Date.parse("2026-09-30T23:00:00.000Z");
  const env = { DAILY_GENERATION_CAP: "2" } as unknown as Partial<Env>;

  it("counts uploads atomically, refuses the third with the reset time, and resets at local midnight", async () => {
    const { obj, state } = await make(fakeState(), env);
    expect(obj.generationAllowance("Europe/London")).toMatchObject({ limit: 2, used: 0, remaining: 2 });
    expect(obj.reserveGeneration("s1", "Europe/London")).toMatchObject({ ok: true, counted: true });
    expect(obj.reserveGeneration("s1", "Europe/London")).toMatchObject({ ok: true, counted: false }); // retried complete
    expect(obj.reserveGeneration("s2", "Europe/London")).toMatchObject({ ok: true, counted: true });
    const third = obj.reserveGeneration("s3", "Europe/London");
    expect(third).toMatchObject({ ok: false, counted: false, limit: 2 });
    expect(third.window).toEqual({ resetAt: LONDON_RESET, timeZone: "Europe/London", sourceIds: ["s1", "s2"] });
    expect(obj.generationAllowance("Asia/Tokyo")).toMatchObject({ remaining: 0 }); // a new zone doesn't reopen the day
    expect(state.data.get("gen:window")).toEqual(third.window);

    vi.setSystemTime(LONDON_RESET - 1);
    expect(obj.reserveGeneration("s3", "Europe/London").ok).toBe(false);
    vi.setSystemTime(LONDON_RESET);
    expect(obj.generationAllowance("Europe/London")).toMatchObject({ used: 0, remaining: 2 });
    const next = obj.reserveGeneration("s3", "Europe/London");
    expect(next).toMatchObject({ ok: true, counted: true });
    expect(next.window.resetAt).toBe(Date.parse("2026-10-01T23:00:00.000Z"));
  });

  it("gives a count back when the run never spent, once", async () => {
    const { obj } = await make(fakeState(), env);
    obj.reserveGeneration("s1", "UTC");
    obj.reserveGeneration("s2", "UTC");
    expect(obj.reserveGeneration("s3", "UTC").ok).toBe(false);
    expect(obj.refundGeneration("s1")).toEqual({ refunded: true });
    expect(obj.refundGeneration("s1")).toEqual({ refunded: false });
    expect(obj.reserveGeneration("s3", "UTC").ok).toBe(true);
  });

  it("defaults to 3 a day, and leaves the prefs alone", async () => {
    const { obj } = await make();
    obj.setPrefs({ defaultMode: "exam" });
    for (const id of ["a", "b", "c"]) expect(obj.reserveGeneration(id, "UTC").ok).toBe(true);
    expect(obj.reserveGeneration("d", "UTC").ok).toBe(false);
    expect(obj.getPrefs().defaultMode).toBe("exam");
  });
});
