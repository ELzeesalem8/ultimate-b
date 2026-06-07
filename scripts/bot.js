const { sendWhatsApp } = require('../whatsappService');
const db = require('../database');
const { Groq } = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `
أنت مساعد مبيعات ذكي لشركة Ocean Trading، متخصصة في طباعة مستلزمات الكافيهات في الرياض.
منتجاتنا: كاسات ورقية (ساخن وبارد)، أغطية، مناديل، أكياس.

مهمتك الوحيدة هي فهم نية العميل واستخراج البيانات المطلوبة بدقة.

قواعد صارمة:
- لا تحسب الأسعار أبداً — فقط استخرج المواصفات وسيتولى النظام الحساب
- لا تخترع معلومات عن المنتجات أو الأسعار
- إذا سأل العميل عن سعر محدد، استخرج المواصفات فقط ولا ترد بسعر
- تحدث بعربية واضحة فيها لمسة خليجية خفيفة
- كن مختصراً وودوداً

عند تحليل أي رسالة، حدد النية من هذه القائمة:
- NEW_ORDER: العميل يريد طلب منتج
- PRICE_INQUIRY: العميل يسأل عن السعر
- ORDER_STATUS: العميل يسأل عن طلب موجود
- COMPLAINT: العميل لديه مشكلة أو شكوى
- REORDER: العميل يريد تكرار طلب سابق
- GREETING: تحية أو رسالة عامة
- UNKNOWN: لا يمكن تحديد النية

عند استخراج بيانات الطلب، أرجع JSON بهذا الشكل فقط بدون أي نص إضافي:
{
  "intent": "NEW_ORDER",
  "data": {
    "product": "كاسات ساخن",
    "size": "9",
    "quantity": "2",
    "layers": "single",
    "has_design": true
  },
  "missing": ["layers"],
  "confidence": 0.95
}

حقل "missing" يحتوي على المعلومات الناقصة التي تحتاج أن تسأل عنها.
حقل "confidence" من 0 إلى 1 يعبر عن مدى تأكدك من فهم النية.

المقاسات المتاحة: 4، 7، 8، 9، 10، 12، 16 أوز
أنواع الطبقات: single (طبقة واحدة)، double (طبقتين)
`;

// ────────────────────────────────────────────────────────────
// 2. PRICING ENGINE — لا تعدل هذا إلا بعد مراجعة الأسعار مع أبوك
// ────────────────────────────────────────────────────────────

const PRICE_TABLE = {
  4:  { single: 180, double: 220 },
  7:  { single: 210, double: 260 },
  8:  { single: 230, double: 285 },
  9:  { single: 260, double: 320 },
  10: { single: 290, double: 360 },
  12: { single: 330, double: 410 },
  16: { single: 390, double: 480 },
};

const PRODUCTS = {
  cups_hot:    { name: "كاسات ورقية (ساخن)", hasSizes: true },
  cups_cold:   { name: "كاسات ورقية (بارد)", hasSizes: true },
  lids:        { name: "أغطية كاسات", hasSizes: false, pricePerCarton: 150 },
  tissues:     { name: "مناديل مطبوعة", hasSizes: false, pricePerCarton: 200 },
  bags:        { name: "أكياس مطبوعة", hasSizes: false, pricePerCarton: 250 },
};

const MIN_ORDER_CARTONS = 1;
const CARTON_SIZE = 1000;
const DEPOSIT_PERCENT = 0.5;
const DELIVERY_DAYS = { min: 4, max: 6 };

function calculatePrice(oz, cartons, layers = "single") {
  const sizeKey = parseInt(oz);
  const layerKey = layers === "double" ? "double" : "single";

  if (!PRICE_TABLE[sizeKey]) return null;

  const pricePerCarton = PRICE_TABLE[sizeKey][layerKey];
  const total = pricePerCarton * cartons;
  const deposit = Math.round(total * DEPOSIT_PERCENT);

  return {
    pricePerCarton,
    cartons,
    units: cartons * CARTON_SIZE,
    total,
    deposit,
    remaining: total - deposit,
  };
}

// ────────────────────────────────────────────────────────────
// 3. MESSAGE TEMPLATES — كل ردود البوت
// ────────────────────────────────────────────────────────────

const MESSAGES = {

  // ── GREETING ──────────────────────────────────────────────

  greeting: () =>
    `السلام عليكم! أهلاً بك في Ocean Trading 🌊

نحن متخصصون في طباعة مستلزمات الكافيهات — كاسات، مناديل، أغطية، وأكياس بشعارك.

كيف أقدر أساعدك اليوم؟`,

  // ── NEW ORDER ─────────────────────────────────────────────

  askOrderDetails: () =>
    `بكل سرور! 

عشان أكمل طلبك، أحتاج منك:

• المنتج (كاسات / مناديل / أكياس / أغطية)
• المقاس — للكاسات: 4 / 7 / 8 / 9 / 10 / 12 / 16 أوز
• الكمية — كم كرتون؟ (الكرتون = 1,000 قطعة، أقل طلب كرتون واحد)
• نوع الكوب — طبقة واحدة أم طبقتين؟
• ملف التصميم / الشعار`,

  askMissing: (missing) => {
    const questions = {
      size: "ما هو المقاس المطلوب؟ (4 / 7 / 8 / 9 / 10 / 12 / 16 أوز)",
      quantity: "كم كرتون تحتاج؟ (الكرتون = 1,000 قطعة)",
      layers: "تفضل طبقة واحدة أم طبقتين؟",
      product: "ما هو المنتج المطلوب؟ (كاسات / مناديل / أكياس / أغطية)",
      has_design: "هل عندك ملف تصميم / شعار جاهز؟",
    };

    const lines = missing
      .filter((f) => questions[f])
      .map((f) => `• ${questions[f]}`)
      .join("\n");

    return `محتاج بعض التفاصيل:\n\n${lines}`;
  },

  orderSummary: (data, pricing) =>
    `تم استلام تفاصيل طلبك ✓

━━━━━━━━━━━━━━━━
ملخص الطلب:
• المنتج: ${data.product || "كاسات ورقية"}
• المقاس: ${data.size} أوز
• الكمية: ${pricing.cartons} كرتون (${pricing.units.toLocaleString("ar")} قطعة)
• النوع: ${data.layers === "double" ? "طبقتان" : "طبقة واحدة"}
• التوصيل: مجاني داخل الرياض
• وقت التسليم: ${DELIVERY_DAYS.min}–${DELIVERY_DAYS.max} أسابيع
━━━━━━━━━━━━━━━━
السعر الإجمالي: ${pricing.total.toLocaleString("ar")} ريال
المقدم المطلوب (50%): ${pricing.deposit.toLocaleString("ar")} ريال
━━━━━━━━━━━━━━━━

هل تريد تأكيد الطلب؟`,

  orderConfirmed: (orderId, pricing) =>
    `تم تأكيد طلبك ✓

رقم الطلب: ${orderId}
المقدم المطلوب: ${pricing.deposit.toLocaleString("ar")} ريال

━━━━━━━━━━━━━━━━
طرق الدفع:
• STC Pay: 05XXXXXXXX
• تحويل بنكي — IBAN: SA•• •••• ••••
━━━━━━━━━━━━━━━━

بعد التحويل أرسل لقطة الشاشة للتأكيد.
سنتواصل معك خلال 24 ساعة لتأكيد التصميم.`,

  askForDesign: () =>
    `ممتاز! الآن أرسل لنا ملف التصميم أو الشعار.

الصيغ المقبولة: PDF أو AI أو PNG بدقة عالية (300 DPI)

ما عندك تصميم؟ لا مشكلة — فريقنا يساعدك.`,

  designReceived: () =>
    `تم استلام الملف ✓

فريقنا سيراجعه ويتواصل معك خلال 24 ساعة للتأكيد على التصميم قبل الطباعة.`,

  // ── PRICE INQUIRY ─────────────────────────────────────────

  priceInquiry: () =>
    `أسعارنا تعتمد على المقاس والكمية.

أقل طلب: كرتون واحد (1,000 قطعة)
التوصيل مجاني داخل الرياض

أرسل لي:
• المقاس (4 / 7 / 8 / 9 / 10 / 12 / 16 أوز)
• الكمية بالكراتين
• طبقة واحدة أم طبقتين؟

وأرسل لك السعر فوراً.`,

  priceQuote: (data, pricing) =>
    `سعر ${data.size} أوز — ${data.layers === "double" ? "طبقتان" : "طبقة واحدة"}:

• السعر لكل كرتون: ${pricing.pricePerCarton.toLocaleString("ar")} ريال
• ${pricing.cartons} كرتون (${pricing.units.toLocaleString("ar")} قطعة): ${pricing.total.toLocaleString("ar")} ريال
• التوصيل: مجاني داخل الرياض

هل تريد المتابعة وتأكيد الطلب؟`,

  // ── ORDER STATUS ──────────────────────────────────────────

  askOrderNumber: () =>
    `أرسل لي رقم الطلب وأرجع لك الحالة فوراً.

رقم الطلب يكون بهذا الشكل: ORD-XXXX`,

  orderStatus: (orderId, status) => {
    const stages = {
      pending:       "في انتظار تأكيد التصميم",
      design:        "مراجعة التصميم — جارٍ الآن",
      printing:      "الطباعة — جارٍ الآن",
      quality_check: "فحص الجودة — جارٍ الآن",
      shipped:       "تم الشحن — في الطريق إليك",
      delivered:     "تم التسليم",
    };

    const currentStage = stages[status] || "جارٍ المعالجة";

    return `طلبك رقم ${orderId}:

الحالة الحالية: ${currentStage}

━━━━━━━━━━━━━━━━
${status === "pending"       ? "◉" : "✓"} انتظار تأكيد التصميم
${status === "design"        ? "◉" : status === "pending" ? "○" : "✓"} مراجعة التصميم
${status === "printing"      ? "◉" : ["pending","design"].includes(status) ? "○" : "✓"} الطباعة
${status === "quality_check" ? "◉" : ["pending","design","printing"].includes(status) ? "○" : "✓"} فحص الجودة
${status === "shipped"       ? "◉" : status === "delivered" ? "✓" : "○"} الشحن
${status === "delivered"     ? "◉" : "○"} التسليم
━━━━━━━━━━━━━━━━

سنرسل لك إشعاراً عند كل تحديث.`;
  },

  orderNotFound: (orderId) =>
    `ما لقيت طلب برقم ${orderId}.

تأكد من الرقم أو تواصل مع فريقنا مباشرة.`,

  // ── COMPLAINT ─────────────────────────────────────────────

  complaintReceived: () =>
    `نأسف لهذا.

أرسل لنا صوراً للمشكلة وسيتولى فريقنا المراجعة فوراً.`,

  complaintLogged: (complaintId) =>
    `تم تسجيل شكواك ✓

رقم الشكوى: ${complaintId}
سيتواصل معك أحد المسؤولين خلال 30 دقيقة.

نعتذر عن الإزعاج ونعمل على حل المشكلة بأسرع وقت.`,

  // ── REORDER ───────────────────────────────────────────────

  reorderPrompt: (customerName, lastOrder) =>
    `السلام عليكم ${customerName}!

مرت ${lastOrder.daysSince} يوم على آخر طلب (${lastOrder.product} — ${lastOrder.size} أوز × ${lastOrder.cartons} كرتون).

هل أوشك مخزونك على الانتهاء؟ نقدر نرتب لك طلباً جديداً بنفس المواصفات.`,

  reorderConfirm: (lastOrder, pricing) =>
    `طلبك السابق:
• ${lastOrder.product} ${lastOrder.size} أوز
• ${lastOrder.cartons} كرتون — ${lastOrder.layers === "double" ? "طبقتان" : "طبقة واحدة"}
• تصميمك محفوظ لدينا ✓

السعر: ${pricing.total.toLocaleString("ar")} ريال
المقدم: ${pricing.deposit.toLocaleString("ar")} ريال

هل تؤكد نفس الطلب؟`,

  // ── MANAGER NOTIFICATION ──────────────────────────────────

  managerAlert: (type, customer, details) => {
    const alerts = {
      new_order: `طلب جديد — ${customer.name} (${customer.phone})\n${details}`,
      complaint: `شكوى — ${customer.name} (${customer.phone})\n${details}\nيحتاج تدخل فوري`,
      large_order: `طلب كبير — ${customer.name} (${customer.phone})\n${details}`,
    };
    return `تنبيه Ocean Trading:\n\n${alerts[type] || details}`;
  },

  // ── DAILY SUMMARY ─────────────────────────────────────────

  dailySummary: (stats) =>
    `ملخص اليوم — Ocean Trading

━━━━━━━━━━━━━━━━
رسائل واردة: ${stats.totalMessages}
طلبات جديدة: ${stats.newOrders}
استفسارات أسعار: ${stats.priceInquiries}
شكاوى: ${stats.complaints}
تدخل بشري: ${stats.escalations}
━━━━━━━━━━━━━━━━
الإجمالي التقديري: ${stats.estimatedRevenue.toLocaleString("ar")} ريال
━━━━━━━━━━━━━━━━

التفاصيل الكاملة في لوحة التحكم.`,

  // ── FALLBACK ──────────────────────────────────────────────

  fallback: () =>
    `ما فهمت طلبك بشكل صحيح.

قدر تعيد الصياغة؟ أو اختر من التالي:
• طلب جديد
• استفسار عن الأسعار
• تتبع طلب
• التحدث مع الفريق`,

  unknownMedia: () =>
    `استلمنا رسالتك.

للطلبات والاستفسارات، أرسل رسالة نصية أو ملف تصميم (PDF / PNG).`,

  outOfHours: () =>
    `شكراً على تواصلك مع Ocean Trading.

أوقات العمل: السبت – الخميس، 9 صباحاً – 9 مساءً

سنرد عليك فور بدء الدوام.`,
};

// ────────────────────────────────────────────────────────────
// 4. INTENT HANDLER — يربط كل شيء مع بعض
// ────────────────────────────────────────────────────────────

const LARGE_ORDER_THRESHOLD = 10; // كراتين

function handleIntent(parsed, session) {
  const { intent, data, missing } = parsed;

  switch (intent) {

    case "GREETING":
      return {
        reply: MESSAGES.greeting(),
        action: "none",
      };

    case "NEW_ORDER":
      if (missing && missing.length > 0) {
        return {
          reply: MESSAGES.askMissing(missing),
          action: "collect_data",
          partialData: data,
        };
      }

      const pricing = calculatePrice(data.size, parseInt(data.quantity), data.layers);
      if (!pricing) {
        return {
          reply: MESSAGES.askMissing(["size"]),
          action: "collect_data",
        };
      }

      const isLargeOrder = parseInt(data.quantity) >= LARGE_ORDER_THRESHOLD;

      return {
        reply: MESSAGES.orderSummary(data, pricing),
        action: "await_confirmation",
        pricing,
        data,
        escalate: isLargeOrder ? "large_order" : null,
      };

    case "PRICE_INQUIRY":
      if (!data.size) {
        return {
          reply: MESSAGES.priceInquiry(),
          action: "collect_price_data",
        };
      }

      const quotePricing = calculatePrice(
        data.size,
        parseInt(data.quantity) || 1,
        data.layers || "single"
      );

      if (!quotePricing) {
        return {
          reply: MESSAGES.priceInquiry(),
          action: "collect_price_data",
        };
      }

      return {
        reply: MESSAGES.priceQuote(data, quotePricing),
        action: "log_lead",
        pricing: quotePricing,
        data,
      };

    case "ORDER_STATUS":
      if (!data.order_id) {
        return {
          reply: MESSAGES.askOrderNumber(),
          action: "await_order_number",
        };
      }

      return {
        reply: null,
        action: "fetch_order_status",
        orderId: data.order_id,
      };

    case "COMPLAINT":
      return {
        reply: MESSAGES.complaintReceived(),
        action: "log_complaint",
        escalate: "complaint",
      };

    case "REORDER":
      return {
        reply: null,
        action: "fetch_last_order",
      };

    case "UNKNOWN":
    default:
      return {
        reply: MESSAGES.fallback(),
        action: "none",
      };
  }
}

// ────────────────────────────────────────────────────────────
// 5. ORDER ID GENERATOR
// ────────────────────────────────────────────────────────────

function generateOrderId() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(Math.random() * 900) + 100;
  return `ORD-${dateStr}-${rand}`;
}

function generateComplaintId() {
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `COMP-${rand}`;
}

// ────────────────────────────────────────────────────────────
// 6. EXPORTS
// ────────────────────────────────────────────────────────────
module.exports = {
  handleWhatsAppMessage, 
  handleIntent,
  SYSTEM_PROMPT,
  PRICE_TABLE,
  PRODUCTS,
  MESSAGES,
  calculatePrice,
  generateOrderId,
  generateComplaintId,
  LARGE_ORDER_THRESHOLD,
  DELIVERY_DAYS
};

// This function connects your 481-line logic to the outside world
async function handleWhatsAppMessage(number, text) {
    try {
        // 1. Let the AI analyze the intent (using your SYSTEM_PROMPT)
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }
        });

        const parsed = JSON.parse(completion.choices[0].message.content);

        // 2. Log to Neon (For your NGU project points!)
        await db.query('INSERT INTO message_logs (remote_jid, message_text, intent) VALUES ($1, $2, $3)', [number, text, parsed.intent]);

        // 3. Run your specific 481-line Intent Handler
        const result = handleIntent(parsed, {}); 
        
        // 4. Send the reply back to the customer
        if (result && result.reply) {
            await sendWhatsApp(number, result.reply);
        }
    } catch (error) {
        console.error("Brain Error:", error);
    }
}

// Ensure handleWhatsAppMessage is in your exports at the bottom!
module.exports = { 
    handleWhatsAppMessage, 
    // ... keep your other exports
};module.exports = {
    handleWhatsAppMessage, // This is the main one
    handleIntent,
    SYSTEM_PROMPT,
    PRICE_TABLE,
    MESSAGES
  };
