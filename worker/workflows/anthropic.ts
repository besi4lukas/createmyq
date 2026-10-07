/**
 * STM-18: the one place the Worker calls a model. Requests go to Anthropic
 * through Cloudflare AI Gateway (AI_GATEWAY_URL, wrangler.jsonc), which logs
 * every call with its tokens and cost. The key is the ANTHROPIC_API_KEY secret.
 *
 * Only the generation Workflow uses this. Taking a quiz never calls a model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NonRetryableError } from "cloudflare:workflows";
import { MAX_OUTPUT_TOKENS, MODEL, RESPONSE_SCHEMA, type ModelCall } from "./generate";

/** One request, including the SDK's own retries of 429 / 5xx / connection errors. */
const REQUEST_TIMEOUT_MS = 90_000;

export function anthropicModel(env: Env): ModelCall {
  if (!env.ANTHROPIC_API_KEY || !env.AI_GATEWAY_URL) {
    throw new NonRetryableError("ANTHROPIC_API_KEY or AI_GATEWAY_URL is not set");
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.AI_GATEWAY_URL, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });

  return async ({ system, user }) => {
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        // No extended thinking: writing questions from a passage doesn't need it, and it would be billed as output.
        thinking: { type: "between_tools" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return {
        text,
        stopReason: message.stop_reason,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    } catch (err) {
      // A bad request, key, model or gateway won't get better by retrying the
      // step. The rest (408, 409, 429, 5xx, network) are what the SDK retries too.
      if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500 && ![408, 409, 429].includes(err.status)) {
        throw new NonRetryableError(`model request failed: ${err.status}`);
      }
      throw err;
    }
  };
}
