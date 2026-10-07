/**
 * STM-18: the one place the Worker calls Anthropic. Requests go through
 * Cloudflare AI Gateway (AI_GATEWAY_URL, wrangler.jsonc), which logs every
 * call with its tokens and cost. The key is the ANTHROPIC_API_KEY secret.
 *
 * Two calls: generation (Sonnet, STM-18) and grading (Haiku, STM-19). Only the
 * generation Workflow uses them. Taking a quiz never calls a model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NonRetryableError } from "cloudflare:workflows";
import { GRADER_MAX_TOKENS, GRADER_MODEL, GRADER_RESPONSE_SCHEMA } from "./filter";
import { MAX_OUTPUT_TOKENS, MODEL, RESPONSE_SCHEMA, type ModelCall } from "./generate";

/** One request, including the SDK's own retries of 429 / 5xx / connection errors. */
const REQUEST_TIMEOUT_MS = 90_000;

type Params = Omit<Anthropic.MessageCreateParamsNonStreaming, "system" | "messages">;

function caller(env: Env, params: Params): ModelCall {
  if (!env.ANTHROPIC_API_KEY || !env.AI_GATEWAY_URL) {
    throw new NonRetryableError("ANTHROPIC_API_KEY or AI_GATEWAY_URL is not set");
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.AI_GATEWAY_URL, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });

  return async ({ system, user }) => {
    try {
      const message = await client.messages.create({ ...params, system, messages: [{ role: "user", content: user }] });
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

/** Writes questions (generate.ts). */
export function anthropicModel(env: Env): ModelCall {
  return caller(env, {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    // No extended thinking: writing questions from a passage doesn't need it, and it would be billed as output.
    thinking: { type: "between_tools" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
  });
}

/** Grades them against the rubric (filter.ts). Haiku 4.5 takes no effort setting and thinks only when asked. */
export function anthropicGrader(env: Env): ModelCall {
  return caller(env, {
    model: GRADER_MODEL,
    max_tokens: GRADER_MAX_TOKENS,
    output_config: { format: { type: "json_schema", schema: GRADER_RESPONSE_SCHEMA } },
  });
}
