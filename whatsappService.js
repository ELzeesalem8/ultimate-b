const axios = require('axios');

/**
 * Sends a WhatsApp message via Evolution API
 * @param {string} number - The recipient's phone number
 * @param {string} text - The message content
 */
async function sendWhatsApp(number, text) {
    const baseUrl = process.env.WHATSAPP_API_URL;
    const instance = process.env.WHATSAPP_INSTANCE;
    const apiKey = process.env.WHATSAPP_API_KEY;

    // Remove any non-numerical characters from the phone number
    const cleanNumber = String(number).replace(/\D/g, "");

    if (!apiKey || !baseUrl) {
        console.error("❌ Missing WhatsApp Configuration in .env");
        return;
    }

    try {
        const response = await axios.post(`${baseUrl}/message/sendText/${instance}`, {
            number: cleanNumber,
            text: text,
            linkPreview: true // Optional: Makes links look professional
        }, {
            headers: {
                "Content-Type": "application/json",
                "apikey": apiKey
            }
        });

        console.log(`✅ Message sent to ${cleanNumber}`);
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to send message to ${cleanNumber}:`, error.response?.data || error.message);
    }
}

module.exports = { sendWhatsApp };