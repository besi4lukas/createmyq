/**
 * STM-15: the generation queue's consumer. Each message names a source that
 * is ready to process; this starts its GenerationWorkflow run and nothing else.
 *
 * Queues deliver at least once, so the run's id comes from the sourceId
 * (rules.ts: instanceIdFor). A second create() for the same id throws; if a
 * run with that id exists, the message was a repeat and is acked. Any other
 * failure is retried (max_retries in wrangler.jsonc), then goes to the
 * dead-letter queue.
 */
import { z } from "zod";
import { instanceIdFor } from "./rules";

export const generationMessage = z.object({ sourceId: z.uuid() });
export type GenerationMessage = z.infer<typeof generationMessage>;

export async function startGenerationRuns(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const body = generationMessage.safeParse(message.body);
    if (!body.success) {
      // Retrying can't fix a malformed message.
      console.error(JSON.stringify({ event: "generation_message_invalid", messageId: message.id }));
      message.ack();
      continue;
    }
    const { sourceId } = body.data;
    const id = instanceIdFor(sourceId);
    try {
      await env.GENERATION_WORKFLOW.create({ id, params: { sourceId } });
      console.log(JSON.stringify({ event: "generation_run_created", instanceId: id, sourceId }));
      message.ack();
    } catch (err) {
      if (await runExists(env, id)) {
        console.log(JSON.stringify({ event: "generation_run_exists", instanceId: id, sourceId }));
        message.ack();
      } else {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ event: "generation_run_create_failed", instanceId: id, sourceId, attempts: message.attempts, error }));
        message.retry();
      }
    }
  }
}

async function runExists(env: Env, id: string): Promise<boolean> {
  try {
    await env.GENERATION_WORKFLOW.get(id);
    return true;
  } catch {
    return false;
  }
}
