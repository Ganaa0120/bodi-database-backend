"use strict";

const { z } = require("zod");
const authService = require("../services/authService");
const env = require("../config/env");

const loginSchema = z.object({
  email: z.string().email("Имэйл хаяг буруу байна."),
  password: z.string().min(1, "Нууц үг оруулна уу."),
});

const REFRESH_COOKIE_NAME = "refresh_token";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/api/auth", // зөвхөн auth endpoint-үүдэд илгээгдэнэ
    maxAge: env.jwt.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}

function getRequestMeta(req) {
  return {
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"] || null,
  };
}

async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { ipAddress, userAgent } = getRequestMeta(req);

    const result = await authService.login({
      email,
      password,
      ipAddress,
      userAgent,
    });

    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(),
    );

    return res.status(200).json({
      accessToken: result.accessToken,
      accessTokenExpiresIn: env.jwt.accessTokenTtl,
      user: result.user,
    });
  } catch (err) {
    return next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    const { ipAddress, userAgent } = getRequestMeta(req);

    const result = await authService.refreshAccessToken({
      refreshToken,
      ipAddress,
      userAgent,
    });

    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      refreshCookieOptions(),
    );

    return res.status(200).json({
      accessToken: result.accessToken,
      accessTokenExpiresIn: env.jwt.accessTokenTtl,
      user: result.user,
    });
  } catch (err) {
    return next(err);
  }
}

async function logout(req, res, next) {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    const { ipAddress, userAgent } = getRequestMeta(req);

    await authService.logout({
      refreshToken,
      userId: req.auth ? req.auth.userId : null,
      ipAddress,
      userAgent,
    });

    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const result = await require("../config/db").query(
      `SELECT id, email, full_name, role, company_id, department_id, last_login_at
       FROM users WHERE id = $1`,
      [req.auth.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Хэрэглэгч олдсонгүй." });
    }
    return res.status(200).json({ user: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

module.exports = { login, refresh, logout, me };
