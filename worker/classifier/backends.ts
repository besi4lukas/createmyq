/**
 * STM-21: the classifiers' real backends, from the Worker's bindings:
 * Workers AI embeddings (the AI binding, embed.ts) and Haiku through AI
 * Gateway (anthropic.ts). STM-22's classify step calls classifierFor(env).
 */
import { anthropicClassifier } from "../workflows/anthropic";
import { embed } from "../workflows/embed";
import { ACTIVE_CLASSIFIER, FALLBACK_THRESHOLD, makeClassifier, type ClassifierKind } from "./index";
import type { Embedder } from "./embedding";
import type { Classifier } from "./types";

export type ClassifierEnv = Pick<Env, "AI" | "ANTHROPIC_API_KEY" | "AI_GATEWAY_URL">;

export function workersAiEmbedder(ai: Ai): Embedder {
  return (input) => embed(ai, input);
}

/**
 * The active classifier with real backends. `kind` and `threshold` are for the
 * benchmark harness; the Workflow passes only env. The model backend is built
 * lazily, so the embedding classifier needs no Anthropic key.
 */
export function classifierFor(env: ClassifierEnv, kind: ClassifierKind = ACTIVE_CLASSIFIER, threshold = FALLBACK_THRESHOLD): Classifier {
  return makeClassifier(
    kind,
    {
      embed: workersAiEmbedder(env.AI),
      model: (request) => anthropicClassifier(env)(request),
    },
    threshold,
  );
}
