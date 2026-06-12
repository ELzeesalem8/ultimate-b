'use strict';
// ============================================================
// scripts/bot.js — Ocean Trading WhatsApp Brain
// ============================================================
const { sendWhatsApp } = require('../whatsappService');
const db = require('../database');
const { Groq } = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────────────────────
// 1. SESSION STORE — per-user conversation memory
//    Fixes: "No session state" bug. Each customer's partial
//    order data and Groq history are preserved across turns.
// ─────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(number) {
  if (!sessions.has(number)) {
    sessions.set(number, {
      history:      [],   // Groq conversation history (rolling 20 messages)
      partialData:  {},   // Partial order data collected across turns
      pendingOrder: null  // Full order awaiting customer confirmation
    });
  }
  return sessions.get(number);
}

function clearSession(number) {
  sessions.delete(number);
}

// ─────────────────────────────────────────────────────────────
// 2. SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
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

أرجع JSON فقط، بدون أي نص إضافي أو markdown:
{
  "intent": "NEW_ORDER",
  "data": {
    "product": "كاسات ساخن",
    "size": "9",
    "quantity": "2",
    "layers": "single",
    "has_design": true,
    "order_id": null
  },
  "missing": ["layers"],
  "confidence": 0.95
}

حقل "missing" يحتوي على المعلومات الناقصة التي تحتاج أن تسأل عنها.
حقل "confidence" من 0 إلى 1.

المقاسات المتاحة: 4، 7، 8، 9، 10، 12، 16 أوز
أنواع الطبقات: single (طبقة واحدة)، double (طبقتين)
`;

// ─────────────────────────────────────────────────────────────
// 3. PRICING ENGINE
//    ⚠️  لا تعدل الأسعار إلا بعد مراجعة مع المدير
// ─────────────────────────────────────────────────────────────
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
  cups_hot:  { name: 'كاسات ورقية (ساخن)', hasSizes: true },
  cups_cold: { name: 'كاسات ورقية (بارد)', hasSizes: true },
  lids:      { name: 'أغطية كاسات',        hasSizes: false, pricePerCarton: 150 },
  tissues:   { name: 'مناديل مطبوعة',      hasSizes: false, pricePerCarton: 200 },
  bags:      { name: 'أكياس مطبوعة',       hasSizes: false, pricePerCarton: 250 },
};

const CARTON_SIZE           = 1000;
const DEPOSIT_PERCENT       = 0.5;
const DELIVERY_DAYS         = { min: 4, max: 6 };
const LARGE_ORDER_THRESHOLD = 10;

function calculatePrice(oz, cartons, layers = 'single') {
  const sizeKey  = parseInt(oz);
  const layerKey = layers === 'double' ? 'double' : 'single';
  if (!PRICE_TABLE[sizeKey]) return null;

  const pricePerCarton = PRICE_TABLE[sizeKey][layerKey];
  const total          = pricePerCarton * cartons;
  const deposit        = Math.round(total * DEPOSIT_PERCENT);

  return {
    pricePerCarton,
    cartons,
    units:     cartons * CARTON_SIZE,
    total,
    deposit,
    remaining: total - deposit,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. MESSAGE TEMPLATES
// ─────────────────────────────────────────────────────────────
const MESSAGES = {
  greeting: () =>
    `السلام عليكم! أهلاً بك في Ocean Trading 🌊\n\nنحن متخصصون في طباعة مستلزمات الكافيهات — كاسات، مناديل، أغطية، وأكياس بشعارك.\n\nكيف أقدر أساعدك اليوم؟`,

  askMissing: (missing) => {
    const questions = {
      size:       'ما هو المقاس المطلوب؟ (4 / 7 / 8 / 9 / 10 / 12 / 16 أوز)',
      quantity:   'كم كرتون تحتاج؟ (الكرتون = 1,000 قطعة)',
      layers:     'تفضل طبقة واحدة أم طبقتين؟',
      product:    'ما هو المنتج المطلوب؟ (كاسات / مناديل / أكياس / أغطية)',
      has_design: 'هل عندك ملف تصميم / شعار جاهز؟',
    };
    const lines = missing
      .filter(f => questions[f])
      .map(f => `• ${questions[f]}`)
      .join('\n');
    return `محتاج بعض التفاصيل:\n\n${lines}`;
  },

  orderSummary: (data, pricing) =>
    `تم استلام تفاصيل طلبك ✓\n\n━━━━━━━━━━━━━━━━\nملخص الطلب:\n• المنتج: ${data.product || 'كاسات ورقية'}\n• المقاس: ${data.size} أوز\n• الكمية: ${pricing.cartons} كرتون (${pricing.units.toLocaleString('ar')} قطعة)\n• النوع: ${data.layers === 'double' ? 'طبقتان' : 'طبقة واحدة'}\n• التوصيل: مجاني داخل الرياض\n• وقت التسليم: ${DELIVERY_DAYS.min}–${DELIVERY_DAYS.max} أسابيع\n━━━━━━━━━━━━━━━━\nالسعر الإجمالي: ${pricing.total.toLocaleString('ar')} ريال\nالمقدم المطلوب (50%): ${pricing.deposit.toLocaleString('ar')} ريال\n━━━━━━━━━━━━━━━━\n\nهل تريد تأكيد الطلب؟`,

  orderConfirmed: (orderId, pricing) =>
    `تم تأكيد طلبك ✓\n\nرقم الطلب: ${orderId}\nالمقدم المطلوب: ${pricing.deposit.toLocaleString('ar')} ريال\n\n━━━━━━━━━━━━━━━━\nطرق الدفع:\n• STC Pay: 05XXXXXXXX\n• تحويل بنكي — IBAN: SA•• •••• ••••\n━━━━━━━━━━━━━━━━\n\nبعد التحويل أرسل لقطة الشاشة للتأكيد.\nسنتواصل معك خلال 24 ساعة لتأكيد التصميم.`,

  priceInquiry: () =>
    `أسعارنا تعتمد على المقاس والكمية.\n\nأقل طلب: كرتون واحد (1,000 قطعة)\nالتوصيل مجاني داخل الرياض\n\nأرسل لي:\n• المقاس (4 / 7 / 8 / 9 / 10 / 12 / 16 أوز)\n• الكمية بالكراتين\n• طبقة واحدة أم طبقتين؟\n\nوأرسل لك السعر فوراً.`,

  priceQuote: (data, pricing) =>
    `سعر ${data.size} أوز — ${data.layers === 'double' ? 'طبقتان' : 'طبقة واحدة'}:\n\n• السعر لكل كرتون: ${pricing.pricePerCarton.toLocaleString('ar')} ريال\n• ${pricing.cartons} كرتون (${pricing.units.toLocaleString('ar')} قطعة): ${pricing.total.toLocaleString('ar')} ريال\n• التوصيل: مجاني داخل الرياض\n\nهل تريد المتابعة وتأكيد الطلب؟`,

  askOrderNumber: () =>
    `أرسل لي رقم الطلب وأرجع لك الحالة فوراً.\n\nرقم الطلب يكون بهذا الشكل: ORD-XXXX`,

  orderStatus: (orderId, status) => {
    const stageOrder = ['pending', 'design', 'printing', 'quality_check', 'shipped', 'delivered'];
    const stageLabels = {
      pending:       'في انتظار تأكيد التصميم',
      design:        'مراجعة التصميم — جارٍ الآن',
      printing:      'الطباعة — جارٍ الآن',
      quality_check: 'فحص الجودة — جارٍ الآن',
      shipped:       'تم الشحن — في الطريق إليك',
      delivered:     'تم التسليم',
    };
    const currentIdx = stageOrder.indexOf(status);
    const marker = (s) => {
      const idx = stageOrder.indexOf(s);
      if (status === s)        return '◉';
      if (idx < currentIdx)    return '✓';
      return '○';
    };
    return `طلبك رقم ${orderId}:\n\nالحالة الحالية: ${stageLabels[status] || 'جارٍ المعالجة'}\n\n━━━━━━━━━━━━━━━━\n${marker('pending')} انتظار تأكيد التصميم\n${marker('design')} مراجعة التصميم\n${marker('printing')} الطباعة\n${marker('quality_check')} فحص الجودة\n${marker('shipped')} الشحن\n${marker('delivered')} التسليم\n━━━━━━━━━━━━━━━━\n\nسنرسل لك إشعاراً عند كل تحديث.`;
  },

  orderNotFound: (orderId) =>
    `ما لقيت طلب برقم ${orderId}.\n\nتأكد من الرقم أو تواصل مع فريقنا مباشرة.`,

  complaintReceived: () =>
    `نأسف لهذا.\n\nأرسل لنا صوراً للمشكلة وسيتولى فريقنا المراجعة فوراً.`,

  complaintLogged: (complaintId) =>
    `تم تسجيل شكواك ✓\n\nرقم الشكوى: ${complaintId}\nسيتواصل معك أحد المسؤولين خلال 30 دقيقة.\n\nنعتذر عن الإزعاج ونعمل على حل المشكلة بأسرع وقت.`,

  reorderConfirm: (lastOrder, pricing) =>
    `طلبك السابق:\n• ${lastOrder.product || 'كاسات'} ${lastOrder.size} أوز\n• ${lastOrder.cartons} كرتون — ${lastOrder.layers === 'double' ? 'طبقتان' : 'طبقة واحدة'}\n• تصميمك محفوظ لدينا ✓\n\nالسعر: ${pricing.total.toLocaleString('ar')} ريال\nالمقدم: ${pricing.deposit.toLocaleString('ar')} ريال\n\nهل تؤكد نفس الطلب؟`,

  managerAlert: (type, customer, details) => {
    const alerts = {
      new_order:   `طلب جديد — (${customer.phone})\n${details}`,
      complaint:   `شكوى — (${customer.phone})\n${details}\nيحتاج تدخل فوري`,
      large_order: `طلب كبير — (${customer.phone})\n${details}`,
    };
    return `تنبيه Ocean Trading:\n\n${alerts[type] || details}`;
  },

  // Fixed: was missing complaints field in original
  dailySummary: (stats) =>
    `ملخص اليوم — Ocean Trading\n\n━━━━━━━━━━━━━━━━\nرسائل واردة: ${stats.totalMessages || 0}\nطلبات جديدة: ${stats.newOrders || 0}\nاستفسارات أسعار: ${stats.priceInquiries || 0}\nشكاوى: ${stats.complaints || 0}\n━━━━━━━━━━━━━━━━\nالإجمالي التقديري: ${(stats.estimatedRevenue || 0).toLocaleString('ar')} ريال\n━━━━━━━━━━━━━━━━\n\nالتفاصيل الكاملة في لوحة التحكم.`,

  fallback: () =>
    `ما فهمت طلبك بشكل صحيح.\n\nقدر تعيد الصياغة؟ أو اختر من التالي:\n• طلب جديد\n• استفسار عن الأسعار\n• تتبع طلب\n• التحدث مع الفريق`,

  unknownMedia: () =>
    `استلمنا رسالتك.\n\nللطلبات والاستفسارات، أرسل رسالة نصية أو ملف تصميم (PDF / PNG).`,
};

// ─────────────────────────────────────────────────────────────
// 5. INTENT HANDLER
//    Fixed: const inside switch now wrapped in blocks {}
//    Fixed: merges partialData from session across turns
// ─────────────────────────────────────────────────────────────
function handleIntent(parsed, session) {
  const { intent, data = {}, missing = [] } = parsed;

  switch (intent) {
    case 'GREETING': {
      return { reply: MESSAGES.greeting(), action: 'none' };
    }

    case 'NEW_ORDER': {
      // Merge AI-extracted data with whatever we saved from previous turns
      const mergedData = { ...session.partialData, ...data };

      if (missing.length > 0) {
        session.partialData = mergedData; // Save progress for next turn
        return { reply: MESSAGES.askMissing(missing), action: 'collect_data' };
      }

      const cartons = parseInt(mergedData.quantity) || 1;
      const pricing = calculatePrice(mergedData.size, cartons, mergedData.layers);

      if (!pricing) {
        return { reply: MESSAGES.askMissing(['size']), action: 'collect_data' };
      }

      // Store for confirmation flow
      session.pendingOrder = { data: mergedData, pricing };
      session.partialData  = {}; // Reset partial data

      const isLargeOrder = cartons >= LARGE_ORDER_THRESHOLD;
      return {
        reply:    MESSAGES.orderSummary(mergedData, pricing),
        action:   'await_confirmation',
        pricing,
        data:     mergedData,
        escalate: isLargeOrder ? 'large_order' : null,
      };
    }

    case 'PRICE_INQUIRY': {
      if (!data.size) {
        return { reply: MESSAGES.priceInquiry(), action: 'collect_price_data' };
      }

      const cartons = parseInt(data.quantity) || 1;
      const pricing = calculatePrice(data.size, cartons, data.layers || 'single');

      if (!pricing) {
        return { reply: MESSAGES.priceInquiry(), action: 'collect_price_data' };
      }

      return { reply: MESSAGES.priceQuote(data, pricing), action: 'log_lead', pricing, data };
    }

    case 'ORDER_STATUS': {
      if (!data.order_id) {
        return { reply: MESSAGES.askOrderNumber(), action: 'await_order_number' };
      }
      // reply: null — handleWhatsAppMessage will fetch from DB and send
      return { reply: null, action: 'fetch_order_status', orderId: data.order_id };
    }

    case 'COMPLAINT': {
      return { reply: null, action: 'log_complaint', escalate: 'complaint' };
    }

    case 'REORDER': {
      // reply: null — handleWhatsAppMessage will fetch from DB and send
      return { reply: null, action: 'fetch_last_order' };
    }

    default: {
      return { reply: MESSAGES.fallback(), action: 'none' };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 6. ID GENERATORS
// ─────────────────────────────────────────────────────────────
function generateOrderId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `ORD-${dateStr}-${Math.floor(Math.random() * 900) + 100}`;
}

function generateComplaintId() {
  return `COMP-${Math.floor(Math.random() * 9000) + 1000}`;
}

// ─────────────────────────────────────────────────────────────
// 7. MAIN HANDLER — called by server.js webhook
//
//    Fixed: conversation history sent to Groq (multi-turn works)
//    Fixed: action handlers actually execute DB fetches
//    Fixed: non-fatal DB errors don't kill the response
// ─────────────────────────────────────────────────────────────
async function handleWhatsAppMessage(number, text) {
  const session = getSession(number);

  try {
    // Add user message to rolling history
    session.history.push({ role: 'user', content: text });

    // Call Groq with conversation context (last 6 messages = 3 back-and-forths)
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.history.slice(-6),
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
    });

    const rawContent = completion.choices[0].message.content;

    // Safe JSON parse — don't crash if Groq returns weird output
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      console.error('[Bot] Groq returned invalid JSON:', rawContent);
      await sendWhatsApp(number, MESSAGES.fallback());
      return;
    }

    // Keep history capped at 20 messages to avoid token bloat
    session.history.push({ role: 'assistant', content: rawContent });
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    // Log to DB (non-fatal if it fails)
    try {
      await db.query(
        'INSERT INTO message_logs (remote_jid, message_text, intent) VALUES ($1, $2, $3)',
        [number, text, parsed.intent]
      );
    } catch (dbErr) {
      console.error('[Bot] DB log failed (non-fatal):', dbErr.message);
    }

    // Run intent handler with real session data
    const result = handleIntent(parsed, session);

    // ── DB-backed actions (previously never executed) ──────

    if (result.action === 'fetch_order_status') {
      try {
        const orderResult = await db.query(
          'SELECT status FROM orders WHERE order_id = $1',
          [result.orderId]
        );
        const reply = orderResult.rows.length > 0
          ? MESSAGES.orderStatus(result.orderId, orderResult.rows[0].status)
          : MESSAGES.orderNotFound(result.orderId);
        await sendWhatsApp(number, reply);
      } catch (e) {
        console.error('[Bot] Order status fetch failed:', e.message);
        await sendWhatsApp(number, MESSAGES.fallback());
      }
      return;
    }

    if (result.action === 'fetch_last_order') {
      try {
        const lastOrderResult = await db.query(
          'SELECT * FROM orders WHERE customer_number = $1 ORDER BY created_at DESC LIMIT 1',
          [number]
        );
        if (lastOrderResult.rows.length > 0) {
          const order   = lastOrderResult.rows[0];
          const pricing = calculatePrice(order.size, order.cartons, order.layers);
          await sendWhatsApp(number, MESSAGES.reorderConfirm(order, pricing));
        } else {
          await sendWhatsApp(number, MESSAGES.greeting());
        }
      } catch (e) {
        console.error('[Bot] Last order fetch failed:', e.message);
        await sendWhatsApp(number, MESSAGES.fallback());
      }
      return;
    }

    if (result.action === 'log_complaint') {
      const complaintId = generateComplaintId();
      try {
        await db.query(
          'INSERT INTO complaints (complaint_id, customer_number, notes) VALUES ($1, $2, $3)',
          [complaintId, number, text]
        );
        const managerNumber = process.env.MANAGER_NUMBER;
        if (managerNumber) {
          await sendWhatsApp(
            managerNumber,
            MESSAGES.managerAlert('complaint', { phone: number }, `الشكوى: ${text}`)
          );
        }
      } catch (e) {
        console.error('[Bot] Complaint log failed:', e.message);
      }
      await sendWhatsApp(number, MESSAGES.complaintLogged(complaintId));
      return;
    }

    // ── Send reply for all remaining intents ───────────────
    if (result.reply) {
      await sendWhatsApp(number, result.reply);
    }

    // Notify manager for large orders
    if (result.escalate === 'large_order') {
      const managerNumber = process.env.MANAGER_NUMBER;
      if (managerNumber) {
        const details = `${result.data?.product} ${result.data?.size} أوز × ${result.data?.quantity} كرتون — ${result.pricing?.total?.toLocaleString('ar')} ريال`;
        await sendWhatsApp(
          managerNumber,
          MESSAGES.managerAlert('large_order', { phone: number }, details)
        );
      }
    }

  } catch (error) {
    console.error('[Bot] Unhandled error:', error);
    try {
      await sendWhatsApp(number, MESSAGES.fallback());
    } catch { /* last resort */ }
  }
}

// ─────────────────────────────────────────────────────────────
// 8. EXPORTS — single, complete, final
//    Fixed: was defined 3 times; last one won and was incomplete
// ─────────────────────────────────────────────────────────────
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
  DELIVERY_DAYS,
};
