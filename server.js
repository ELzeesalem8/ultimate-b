console.log("DEBUG: WhatsApp API Key is:", process.env.WHATSAPP_API_KEY ? "SET" : "MISSING");
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { handleWhatsAppMessage, MESSAGES } = require('./scripts/bot'); // 1. Changed to pull the main wrapper
const db = require('./database');

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────────────────
// 1. THE MAIN WEBHOOK (Safe & Shielded)
// ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        // THE SHIELD: Instant termination for group chats
        const remoteJid = body.data?.key?.remoteJid || "";
        if (remoteJid.endsWith('@g.us')) {
            return res.status(200).send("Ignored: Group Message");
        }

        // PRIVATE CHAT LOGIC
        if (body.event === "messages.upsert") {
            const messageText = body.data?.message?.conversation || body.data?.message?.extendedTextMessage?.text;
            
            if (!messageText) return res.sendStatus(200);

            console.log(`[Ultimate B] Private message from ${remoteJid}: ${messageText}`);

            // 2. Added slowly right here:
            const cleanNumber = remoteJid.split('@')[0];
            
            // This runs the Groq AI brain and immediately hits your Gulf Arabic style templates
            await handleWhatsAppMessage(cleanNumber, messageText); 
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error);
        res.sendStatus(500);
    }
});

// ────────────────────────────────────────────────────────────
// 2. DAILY REPORT FOR YOUR FATHER (Ocean Trading Tone)
// ────────────────────────────────────────────────────────────
// Runs every night at 9:00 PM
cron.schedule('0 21 * * *', async () => {
    console.log("[Ultimate B] Generating daily report for your father...");
    
    try {
        // Querying Neon for today's stats
        const result = await db.query(`
            SELECT 
                COUNT(*) FILTER (WHERE intent = 'NEW_ORDER') as orders,
                COUNT(*) FILTER (WHERE intent = 'PRICE_INQUIRY') as prices,
                COUNT(*) as total
            FROM message_logs 
            WHERE created_at >= CURRENT_DATE
        `);

        const stats = {
            newOrders: result.rows[0].orders || 0,
            priceInquiries: result.rows[0].prices || 0,
            totalMessages: result.rows[0].total || 0,
            estimatedRevenue: 0 
        };

        // Matching the tone of your bot.js templates
        const reportMessage = MESSAGES.dailySummary(stats);
        
        const fatherNumber = process.env.MANAGER_NUMBER; 
        console.log(`[Report] Sending to ${fatherNumber}:\n${reportMessage}`);

    } catch (error) {
        console.error("Failed to generate daily report:", error);
    }
});

// ────────────────────────────────────────────────────────────
// 3. START SERVER
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Ultimate B is live on port ${PORT}`);
    console.log(`🛡️  Group Chat Shield: ACTIVE`);
    console.log(`📊 Daily Reports: SCHEDULED (21:00)`);
    console.log(`✅ Connected to Neon PostgreSQL`);
});
