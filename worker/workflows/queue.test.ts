import { describe, expect, it, vi } from "vitest";
import { startGenerationRuns } from "./queue";

const SOURCE_ID = "0b7c3f0e-8a6f-4c1e-9a43-5d2b1f7e9c10";

function message(body: unknown) {
  return { id: "m1", body, attempts: 1, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
}

/** A fake Workflow binding that remembers ids, like the real one (create throws on a repeat). */
function fakeWorkflow(opts: { failCreate?: boolean } = {}) {
  const ids = new Set<string>();
  return {
    ids,
    create: vi.fn(async ({ id }: { id: string }) => {
      if (opts.failCreate || ids.has(id)) throw new Error("instance.already_exists or outage");
      ids.add(id);
    }),
    get: vi.fn(async (id: string) => {
      if (!ids.has(id)) throw new Error("instance.not_found");
    }),
  };
}

async function deliver(workflow: ReturnType<typeof fakeWorkflow>, msg: ReturnType<typeof message>) {
  const env = { GENERATION_WORKFLOW: workflow } as unknown as Env;
  await startGenerationRuns({ queue: "q", messages: [msg] } as unknown as MessageBatch<unknown>, env);
}

describe("startGenerationRuns", () => {
  it("starts one run per source, and acks a redelivered message without a second run", async () => {
    const workflow = fakeWorkflow();
    const first = message({ sourceId: SOURCE_ID });
    const again = message({ sourceId: SOURCE_ID });
    await deliver(workflow, first);
    await deliver(workflow, again);
    expect([...workflow.ids]).toEqual([`source-${SOURCE_ID}`]);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(again.ack).toHaveBeenCalledOnce();
    expect(again.retry).not.toHaveBeenCalled();
  });

  it("retries when the run could not be created", async () => {
    const msg = message({ sourceId: SOURCE_ID });
    await deliver(fakeWorkflow({ failCreate: true }), msg);
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("drops a malformed message instead of retrying it", async () => {
    const workflow = fakeWorkflow();
    const msg = message({ sourceId: "not-a-uuid" });
    await deliver(workflow, msg);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(workflow.create).not.toHaveBeenCalled();
  });
});
