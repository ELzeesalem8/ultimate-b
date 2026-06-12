require('dotenv').config();
console.log("DEBUG: WhatsApp API Key is:", process.env.WHATSAPP_API_KEY || process.env.AUTHENTICATION_GLOBAL_API_KEY ? "SET" : "MISSING");

const express = require('express');
const cron    = require('node-cron');
const { handleWhatsAppMessage, MESSAGES } = require('./scripts/bot');
const { sendWhatsApp } = require('./whatsappService');
const db = require('./database');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// 1. WEBHOOK — acks Evolution API INSTANTLY, processes after
//    Fixed: res.sendStatus(200) now happens BEFORE Groq runs,
//    preventing Evo Manager retries → preventing 429s
// ─────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
    // Respond first — Evolution API stops waiting immediately
    res.sendStatus(200);

    // Process in the background, errors won't affect the response
    (async () => {
        try {
            const body      = req.body;
            const remoteJid = body.data?.key?.remoteJid || "";

            // Shield 1: ignore group chats
            if (remoteJid.endsWith('@g.us')) return;

            // Shield 2: ignore our own messages (prevents reply loops)
            if (body.data?.key?.fromMe) return;

            if (body.event === "messages.upsert") {
                const messageText =
                    body.data?.message?.conversation ||
                    body.data?.message?.extendedTextMessage?.text;

                if (!messageText) return;

                const cleanNumber = remoteJid.split('@')[0];
                console.log(`[Ultimate B] From ${cleanNumber}: ${messageText}`);

                await handleWhatsAppMessage(cleanNumber, messageText);
            }
        } catch (error) {
            console.error("Webhook Error:", error);
        }
    })();
});

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// 2. DAILY REPORT (9 PM) — now actually sends via WhatsApp
// ─────────────────────────────────────────────────────────────
cron.schedule('0 21 * * *', async () => {
    console.log("[Ultimate B] Generating daily report...");

    try {
        const result = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE intent = 'NEW_ORDER')     AS orders,
                COUNT(*) FILTER (WHERE intent = 'PRICE_INQUIRY') AS prices,
                COUNT(*) FILTER (WHERE intent = 'COMPLAINT')     AS complaints,
                COUNT(*)                                          AS total
            FROM message_logs
            WHERE created_at >= CURRENT_DATE
        `);

        const row   = result.rows[0];
        const stats = {
            newOrders:        parseInt(row.orders)     || 0,
            priceInquiries:   parseInt(row.prices)     || 0,
            complaints:       parseInt(row.complaints) || 0,
            totalMessages:    parseInt(row.total)      || 0,
            estimatedRevenue: 0,
        };

        const reportMessage = MESSAGES.dailySummary(stats);
        const fatherNumber  = process.env.MANAGER_NUMBER;

        if (!fatherNumber) {
            console.warn("[Report] MANAGER_NUMBER not set — printing instead:");
            console.log(reportMessage);
            return;
        }

        await sendWhatsApp(fatherNumber, reportMessage);
        console.log(`[Report] Sent to ${fatherNumber}`);

    } catch (error) {
        console.error("Failed to generate daily report:", error);
    }
});

// ─────────────────────────────────────────────────────────────
// 3. START SERVER
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Ultimate B is live on port ${PORT}`);
    console.log(`🛡️  Group + Self-Message Shield: ACTIVE`);
    console.log(`📊 Daily Reports: SCHEDULED (21:00)`);
    console.log(`✅ Connected to Neon PostgreSQL`);
});
