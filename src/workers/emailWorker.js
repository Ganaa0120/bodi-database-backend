"use strict";

const { query, runInSystemContext } = require("../config/db");
const mailService = require("../services/mailService");
const logger = require("../utils/logger");

/**
 * Мэдэгдлийн имэйлийн outbox worker.
 *
 * - 15 секунд тутамд 'pending' мөрүүдээс 5-ыг авч илгээнэ (минутад ~20 —
 *   Exchange Online-ийн mailbox-ийн хурдны хязгаараас доогуур).
 * - FOR UPDATE SKIP LOCKED — App Service олон instance-тай байсан ч нэг
 *   имэйл хоёр удаа явахгүй.
 * - Бүтэлгүйтвэл 1 мин, 5 минутын дараа дахин оролдоно; 3 удаа бүтэлгүйтвэл
 *   'failed'. Буруу хаяг зэрэг засрахгүй алдаа шууд 'failed'.
 * - 'sending' төлөвт 10 минутаас удаан гацсан мөрийг (server унасан г.м)
 *   буцааж 'pending' болгоно.
 * - Mail тохиргоо дутуу бол юу ч хийхгүй — мөрүүд 'pending' хэвээр хүлээнэ.
 *
 * App Service дээр "Always On" асаалттай байх ёстой, эс бөгөөс app унтах
 * үед worker зогсоно.
 */

const INTERVAL_MS = 15_000;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_SECONDS = [60, 300]; // 1 дэх, 2 дахь бүтэлгүйтлийн дараа
const STUCK_MINUTES = 10;

let timer = null;
let running = false;
let warnedNotConfigured = false;

async function recoverStuck() {
  const result = await query(
    `UPDATE notification_recipients
     SET email_status = 'pending', email_next_attempt_at = now()
     WHERE email_status = 'sending'
       AND email_last_attempt_at < now() - make_interval(mins => $1)`,
    [STUCK_MINUTES],
  );
  if (result.rowCount > 0) {
    logger.warn("Гацсан имэйлүүдийг дахин дараалалд орууллаа", {
      count: result.rowCount,
    });
  }
}

async function claimBatch() {
  const result = await query(
    `UPDATE notification_recipients r
     SET email_status = 'sending',
         email_attempts = r.email_attempts + 1,
         email_last_attempt_at = now()
     FROM (
       SELECT notification_id, user_id
       FROM notification_recipients
       WHERE email_status = 'pending'
         AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= now())
       ORDER BY email_next_attempt_at NULLS FIRST, created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ) pick
     WHERE r.notification_id = pick.notification_id
       AND r.user_id = pick.user_id
     RETURNING r.notification_id, r.user_id, r.email_attempts`,
    [BATCH_SIZE],
  );
  return result.rows;
}

async function loadJob(notificationId, userId) {
  const result = await query(
    `SELECT n.title, n.body, n.deleted_at AS notification_deleted_at,
            u.email, u.full_name, u.is_active, u.deleted_at AS user_deleted_at,
            (SELECT count(*)::int FROM notification_attachments a
             WHERE a.notification_id = n.id) AS attachment_count
     FROM notifications n
     JOIN users u ON u.id = $2
     WHERE n.id = $1`,
    [notificationId, userId],
  );
  return result.rows[0] || null;
}

async function markStatus(
  job,
  status,
  { error = null, retryInSeconds = null } = {},
) {
  await query(
    `UPDATE notification_recipients
     SET email_status = $3,
         email_sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE email_sent_at END,
         email_last_error = $4,
         email_next_attempt_at = CASE WHEN $5::int IS NULL THEN NULL
                                      ELSE now() + make_interval(secs => $5::int) END
     WHERE notification_id = $1 AND user_id = $2`,
    [
      job.notification_id,
      job.user_id,
      status,
      error ? String(error).slice(0, 500) : null,
      retryInSeconds,
    ],
  );
}

async function processJob(job) {
  const data = await loadJob(job.notification_id, job.user_id);

  if (
    !data ||
    data.notification_deleted_at ||
    data.user_deleted_at ||
    !data.is_active ||
    !data.email
  ) {
    await markStatus(job, "skipped", {
      error: "Мэдэгдэл эсвэл хүлээн авагч идэвхгүй болсон.",
    });
    return;
  }

  try {
    const { subject, html } = mailService.buildNotificationEmail({
      fullName: data.full_name,
      title: data.title,
      body: data.body,
      attachmentCount: data.attachment_count,
    });
    await mailService.sendMail({ to: data.email, subject, html });
    await markStatus(job, "sent");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const canRetry = !err.permanent && job.email_attempts < MAX_ATTEMPTS;

    if (canRetry) {
      const delay =
        RETRY_DELAYS_SECONDS[
          Math.min(job.email_attempts - 1, RETRY_DELAYS_SECONDS.length - 1)
        ];
      await markStatus(job, "pending", {
        error: message,
        retryInSeconds: delay,
      });
    } else {
      await markStatus(job, "failed", { error: message });
    }
    logger.error("Мэдэгдлийн имэйл илгээж чадсангүй", {
      notificationId: job.notification_id,
      userId: job.user_id,
      attempt: job.email_attempts,
      willRetry: canRetry,
      error: message,
    });
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    if (!mailService.isConfigured()) {
      if (!warnedNotConfigured) {
        logger.warn(
          "Имэйлийн тохиргоо дутуу — мэдэгдлийн имэйлүүд pending төлөвтэй хүлээнэ.",
        );
        warnedNotConfigured = true;
      }
      return;
    }
    warnedNotConfigured = false;

    await runInSystemContext(async () => {
      await recoverStuck();
      const jobs = await claimBatch();
      for (const job of jobs) {
        await processJob(job);
      }
    });
  } catch (err) {
    logger.error("Email worker алдаа", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  if (process.env.EMAIL_WORKER_ENABLED === "false") {
    logger.info("Email worker унтраалттай (EMAIL_WORKER_ENABLED=false).");
    return;
  }
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref(); // graceful shutdown-ийг саатуулахгүй
  setTimeout(tick, 3000).unref(); // server асаад удалгүй эхний шалгалт
  logger.info("Email worker ажиллаж эхэллээ", {
    intervalMs: INTERVAL_MS,
    batchSize: BATCH_SIZE,
  });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
