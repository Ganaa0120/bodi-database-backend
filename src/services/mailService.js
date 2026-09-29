"use strict";

/**
 * Имэйл илгээх — Microsoft Graph API (sendMail), @bodigroup.mn mailbox-оос.
 *
 * SMTP Basic Auth биш Graph ашиглаж байгаа шалтгаан: Microsoft 2026 оны
 * 12-р сарын сүүлээс Exchange Online дээр SMTP AUTH Basic Auth-ийг default-оор
 * унтраана. Graph + client credentials (OAuth) энэ өөрчлөлтөд өртөхгүй.
 *
 * Env хувьсагчид (App Service → Environment variables, эсвэл Key Vault reference):
 *   MS_TENANT_ID      — Entra ID tenant id
 *   MS_CLIENT_ID      — App registration-ийн client id
 *   MS_CLIENT_SECRET  — App registration-ийн client secret
 *   MAIL_SENDER       — илгээгч mailbox, жишээ нь noreply@bodigroup.mn
 *   APP_URL           — системийн frontend URL (имэйл дэх товчны холбоос)
 *
 * Эдгээр тохируулагдаагүй бол isConfigured() = false — систем имэйлгүйгээр
 * хэвийн ажиллана, имэйлүүд outbox-д 'pending' төлөвтэй хүлээнэ.
 */

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function isConfigured() {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_SENDER, APP_URL } =
    process.env;
  return Boolean(
    MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MAIL_SENDER && APP_URL,
  );
}

function appUrl() {
  return (process.env.APP_URL || "").replace(/\/+$/, "");
}

async function getGraphToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) return cachedToken;

  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Graph token авахад алдаа: ${res.status} ${data.error || ""}`.trim(),
    );
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Нэг хүлээн авагч руу HTML имэйл илгээнэ. Алдаа гарвал throw хийнэ —
 * дахин оролдох шийдвэрийг дуудагч (worker) гаргана.
 */
async function sendMail({ to, subject, html }) {
  if (!isConfigured()) {
    throw new Error(
      "Имэйлийн тохиргоо (MS_* / MAIL_SENDER / APP_URL) дутуу байна.",
    );
  }

  const token = await getGraphToken();
  const sender = process.env.MAIL_SENDER;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    },
  );

  // Graph sendMail амжилттай бол 202 Accepted
  if (res.status !== 202) {
    if (res.status === 401) cachedToken = null; // token хүчингүй болсон байж болно
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `Graph sendMail ${res.status}: ${detail.slice(0, 300)}`,
    );
    // 4xx (401, 429-өөс бусад) нь дахин оролдоход засрахгүй — жишээ нь хаяг буруу
    err.permanent =
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 429 &&
      res.status !== 401;
    throw err;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Мэдэгдлийн имэйлийн template. Агуулга plain text — HTML болгон escape хийнэ. */
function buildNotificationEmail({ fullName, title, body, attachmentCount }) {
  const link = `${appUrl()}/dashboard/notifications`;
  const bodyHtml = escapeHtml(body).replace(/\r?\n/g, "<br />");

  const attachmentNote =
    attachmentCount > 0
      ? `<p style="margin:18px 0 0;padding:10px 14px;background:#EEF4FB;border-radius:10px;font-size:13px;color:#334155;">
           📎 Энэ мэдэгдэл ${attachmentCount} хавсралттай. Хавсралтыг системд нэвтэрч үзнэ үү.
         </p>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="mn">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#0B2A4A;padding:18px 28px;color:#ffffff;font-size:16px;font-weight:600;">
          Bodi Group — Санхүүгийн систем
        </td></tr>
        <tr><td style="height:3px;background:#F48120;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 14px;color:#475569;">Сайн байна уу, ${escapeHtml(fullName)}.</p>
          <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;color:#0B2A4A;">${escapeHtml(title)}</h1>
          <div style="margin:0;color:#1e293b;">${bodyHtml}</div>
          ${attachmentNote}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
            <tr><td style="border-radius:10px;background:#0071BB;">
              <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-weight:600;text-decoration:none;">
                Системд нэвтэрч харах
              </a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
          Энэ имэйлийг Bodi Group-ийн санхүүгийн системээс автоматаар илгээсэн тул хариу бичих шаардлагагүй.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: `[Bodi Group] ${title}`, html };
}

module.exports = { isConfigured, sendMail, buildNotificationEmail };
