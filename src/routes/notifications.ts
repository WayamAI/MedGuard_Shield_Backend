import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { ctxOf } from "../middleware/auth.js";
import { ok, paged } from "../lib/http.js";
import { pageParams, paginationQuery } from "../lib/pagination.js";
import { listNotifications, markAllRead, markRead, unreadCount } from "../services/notificationService.js";

export const notificationsRouter = Router();

notificationsRouter.get("/", validate({ query: paginationQuery }), async (req, res, next) => {
  try {
    const ctx = ctxOf(req);
    const page = pageParams(paginationQuery.parse(req.query));
    const { items, meta } = await listNotifications(ctx, page);
    paged(res, items, meta);
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get("/unread-count", async (req, res, next) => {
  try {
    ok(res, { count: await unreadCount(ctxOf(req)) });
  } catch (err) {
    next(err);
  }
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

notificationsRouter.post("/:id/read", validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    await markRead(ctxOf(req), id);
    ok(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/read-all", async (req, res, next) => {
  try {
    const marked = await markAllRead(ctxOf(req));
    ok(res, { ok: true, marked });
  } catch (err) {
    next(err);
  }
});
