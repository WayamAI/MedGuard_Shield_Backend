import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { login } from "../services/authService.js";

export const authRouter = Router();

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const COOKIE_NAME = "medguard_token";

authRouter.post("/login", validate({ body: loginBody }), async (req, res, next) => {
  try {
    const { email, password } = loginBody.parse(req.body);
    const result = await login(email, password);

    // Cookie for browser clients; the token is also returned so a fetch client
    // can hold it itself. Not `secure` because the demo runs over plain http.
    res.cookie?.(COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: result.expiresIn * 1000,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", (_req, res) => {
  // Stateless JWTs cannot be revoked server-side without a denylist, which is
  // more than the demo needs; clearing the cookie ends the browser session.
  res.clearCookie?.(COOKIE_NAME);
  res.json({ data: { ok: true } });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ data: req.user });
});
