/**
 * Sources that are not file uploads, and every source's status.
 *
 *   POST /api/sources/link  { url, requestId, timeZone? } → 201/200 { source }
 *     An article or YouTube link. Checked (link-rules.ts), then exactly like
 *     POST /api/uploads/complete: one transaction (recordSource) creates the
 *     private `sources` row (status `uploaded`, kind article|youtube, url) and
 *     its `source_uploads` row; a new source must pass the spend ceiling (503
 *     spend_ceiling) and the daily cap (429 daily_cap, counted here); then the
 *     same queue message as an upload. A retry with the same requestId returns
 *     the same source and is not counted again.
 *   GET  /api/sources?tz=   the caller's own sources, newest first, in any
 *     status (own-source.ts: listOwnSources), and today's generation usage
 *     from their UserSession (STM-24 `gen:window`, read-only):
 *     { sources, usage: { used, limit, resetAt, message } }. `message` is the
 *     daily-cap message with the reset time once the cap is reached, else null.
 *   GET  /api/sources/:id   the caller's own source and its status (any kind)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/session";
import { apiError, readJson } from "../http";
import { admitGeneration, refusalResponse, userSession } from "../limits/admission";
import { capMessage, safeTimeZone } from "../limits/daily-cap";
import { recordSource } from "../uploads/record-source";
import type { GenerationMessage } from "../workflows/queue";
import { NOT_A_LINK, checkLink, linkSourceBody, titleFromLink } from "./link-rules";
import { findOwnSource, listOwnSources } from "./own-source";

export const sourceRoutes = new Hono<AppEnv>();

const SOURCE_NOT_FOUND = "We could not find that source.";

sourceRoutes.post("/sources/link", async (c) => {
  const input = linkSourceBody.safeParse(await readJson(c));
  if (!input.success) return apiError(c, 400, NOT_A_LINK, { code: "bad_url" });
  const check = checkLink(input.data.url);
  if (!check.ok) return apiError(c, 400, check.error, { code: check.code });

  const { link } = check;
  const sourceId = input.data.requestId;
  const now = new Date();
  const tz = safeTimeZone(input.data.timeZone);
  const result = await recordSource(
    c.var.db,
    { id: sourceId, ownerId: c.var.user.id, kind: link.kind, url: link.url, title: titleFromLink(link) },
    (tx) => admitGeneration(c, tx, sourceId, tz, now),
  );
  if ("refused" in result) return refusalResponse(c, result.refused);
  // The id is someone else's source (a reused requestId): never theirs to see.
  if (!result.source) return apiError(c, 409, "That request could not be used. Please try again.", { code: "request_conflict" });

  if (result.source.status === "uploaded") {
    await c.env.GENERATION_QUEUE.send({ sourceId } satisfies GenerationMessage);
  }
  return c.json({ source: result.source }, result.created ? 201 : 200);
});

sourceRoutes.get("/sources", async (c) => {
  const [sources, allowance] = await Promise.all([
    listOwnSources(c.var.db, c.var.user.id),
    userSession(c).generationAllowance(safeTimeZone(c.req.query("tz"))),
  ]);
  const { used, limit, remaining, window } = allowance;
  return c.json({
    sources,
    usage: {
      used,
      limit,
      resetAt: new Date(window.resetAt).toISOString(),
      message: remaining === 0 ? capMessage(window, Date.now()) : null,
    },
  });
});

sourceRoutes.get("/sources/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  const source = id.success ? await findOwnSource(c.var.db, c.var.user.id, id.data) : null;
  return source ? c.json({ source }) : apiError(c, 404, SOURCE_NOT_FOUND, { code: "source_not_found" });
});
