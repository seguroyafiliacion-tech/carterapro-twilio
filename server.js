require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  FIREBASE_DB_URL,
  AXA_PAYMENT_LINK,
  DAILY_LIMIT
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;

const LIMIT = Number(DAILY_LIMIT || 50);
const PAYMENT_LINK = AXA_PAYMENT_LINK || "https://cajaaxa.mitec.com.mx/cua/inicio.do?method=loginAgente&perfil=cliente";

function cleanPhone(phone = "") {
  return String(phone).replace(/\D/g, "").slice(-10);
}

function toWhatsapp(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("52") && digits.length >= 12) return `whatsapp:+${digits}`;
  if (digits.length === 10) return `whatsapp:+52${digits}`;
  return `whatsapp:+${digits}`;
}

function money(v) {
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return "";
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function daysFrom(value) {
  const iso = dateOnly(value);
  if (!iso) return 9999;
  const d = new Date(iso + "T00:00:00");
  const now = new Date(todayISO() + "T00:00:00");
  return Math.floor((now - d) / 86400000);
}

function daysUntil(value) {
  const iso = dateOnly(value);
  if (!iso) return 9999;
  const d = new Date(iso + "T00:00:00");
  const now = new Date(todayISO() + "T00:00:00");
  return Math.ceil((d - now) / 86400000);
}

function firebaseUrl(path = "") {
  const base = String(FIREBASE_DB_URL || "").replace(/\/$/, "");
  const clean = String(path || "").replace(/^\/+/, "");
  return `${base}/${clean}.json`;
}

async function dbGet(path = "") {
  const res = await fetch(firebaseUrl(path));
  if (!res.ok) throw new Error(`Firebase GET ${path}: ${res.status}`);
  return (await res.json()) || null;
}

async function dbPatch(updates = {}) {
  const res = await fetch(firebaseUrl(""), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!res.ok) throw new Error(`Firebase PATCH: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function sendWhatsApp(phone, body) {
  const msg = await client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsapp(phone),
    body
  });
  return msg.sid;
}

function isPaid(policy) {
  const text = [
    policy.payment_status,
    policy.estatus_axa,
    policy.axa_status,
    policy.whatsapp_status
  ].join(" ").toLowerCase();

  return text.includes("pagado") ||
         text.includes("pagada") ||
         text.includes("vigente pagada") ||
         text.includes("pagada axa");
}

function isCanceled(policy) {
  const text = [
    policy.payment_status,
    policy.estatus_axa,
    policy.axa_status,
    policy.whatsapp_status
  ].join(" ").toLowerCase();

  return text.includes("cancel") ||
         text.includes("no vigente") ||
         text.includes("falta de pago");
}

function issueDate(policy) {
  return policy.emision ||
         policy.fecha_emision ||
         policy.vigencia_inicio ||
         policy.fecha_vigor_axa ||
         policy.created_at ||
         "";
}

function amountText(policy) {
  return money(policy.total || policy.prima_total || policy.last_axa_paid_premium || policy.prima_neta) || "el importe pendiente";
}

function policyPhone(policy) {
  return policy.telefono || policy.whatsapp || policy.celular || policy.phone || "";
}

function classifyPolicy(policy) {
  if (isPaid(policy)) return "pagada";

  const issuedDays = daysFrom(issueDate(policy));
  const dueDays = daysUntil(policy.vigencia_fin);

  if (isCanceled(policy) && issuedDays >= 45) return "cancelada_falta_pago";
  if (issuedDays >= 30 && !isPaid(policy)) return "riesgo_cancelacion";
  if (issuedDays >= 0 && issuedDays < 14 && !isPaid(policy)) return "intento_cobro";
  if (dueDays <= 15 && dueDays >= 0) return "por_vencer";
  return "pendiente_pago";
}

function paymentInstructions(policy = {}) {
  const poliza = policy.poliza || "";
  return `Para realizar o revisar el pago de tu póliza AXA No. ${poliza}, entra a:

${PAYMENT_LINK}

Ahí selecciona la opción de cliente e ingresa tu número de póliza.

Si todavía no aparece para pagar, normalmente significa que aún está en intento de cobro a tu tarjeta. Mantén disponible el monto en tu tarjeta.

Si no se logra cobrar automáticamente dentro de aproximadamente 2 semanas después de la emisión, el pago deberá aparecer en ese enlace.

Después de pagar, envía tu comprobante por este mismo WhatsApp.`;
}

function buildMessage(policy, type = "") {
  const status = type || classifyPolicy(policy);
  const nombre = policy.nombre || policy.contratante || "cliente";
  const poliza = policy.poliza || "";
  const monto = amountText(policy);
  const fin = policy.vigencia_fin || "próxima fecha";
  const emitida = issueDate(policy) || "fecha de emisión";

  if (status === "intento_cobro") {
    return `Hola ${nombre}. Tu póliza AXA No. ${poliza} está en seguimiento de pago.

Aún puede estar en intento de cobro automático a tu tarjeta. Por favor mantén disponible ${monto} en tu tarjeta.

Si el cargo no se realiza dentro de aproximadamente 2 semanas después de la emisión (${emitida}), podrás pagar desde este enlace:

${PAYMENT_LINK}

Al pagar, envía tu comprobante por este WhatsApp.

Responde:
PAGAR para recibir instrucciones
PAGADO si ya pagaste
ASESOR si necesitas ayuda`;
  }

  if (status === "riesgo_cancelacion") {
    return `Hola ${nombre}. Tu póliza AXA No. ${poliza} sigue pendiente de pago y está en riesgo de cancelarse por falta de pago.

Importe: ${monto}

Puedes revisar o pagar aquí:
${PAYMENT_LINK}

Ingresa con tu número de póliza. Después de pagar, envía tu comprobante por este WhatsApp.

Responde PAGAR, PAGADO o ASESOR.`;
  }

  if (status === "cancelada_falta_pago") {
    return `Hola ${nombre}. Tu póliza AXA No. ${poliza} aparece como no vigente o cancelada por falta de pago.

Para revisar si aún permite pago, entra aquí:
${PAYMENT_LINK}

Ingresa tu número de póliza. Si no aparece, responde ASESOR para revisar opciones.`;
  }

  if (status === "por_vencer") {
    return `Hola ${nombre}. Te recordamos que tu póliza AXA No. ${poliza} vence el ${fin}.

Para revisar pago o renovación:
${PAYMENT_LINK}

Ingresa tu número de póliza. Si realizas el pago, envía tu comprobante por este WhatsApp.

Responde PAGAR, PAGADO o ASESOR.`;
  }

  if (status === "pagada") {
    return `Hola ${nombre}. Tu póliza AXA No. ${poliza} aparece como pagada/vigente.

Si tienes comprobante o necesitas apoyo, puedes responder por este medio.`;
  }

  return `Hola ${nombre}. Te recordamos que tu póliza AXA No. ${poliza} tiene pago pendiente.

Importe: ${monto}

Para revisar o pagar entra aquí:
${PAYMENT_LINK}

Ingresa tu número de póliza. Si aún no aparece, puede estar en intento de cobro automático; mantén disponible el monto en tu tarjeta. Si no se cobra en aproximadamente 2 semanas después de la emisión, aparecerá el pago en ese enlace.

Después de pagar, envía tu comprobante por este WhatsApp.

Responde PAGAR, PAGADO o ASESOR.`;
}

async function findPolicyByNumber(policyNumber) {
  const cleanPolicy = String(policyNumber || "").replace(/\D/g, "");
  if (!cleanPolicy) return null;
  const users = (await dbGet("users")) || {};

  for (const [uid, user] of Object.entries(users)) {
    const policies = user.policies || {};
    for (const [policyKey, policy] of Object.entries(policies)) {
      if (String(policy.poliza || policyKey).replace(/\D/g, "") === cleanPolicy) {
        return { uid, policyKey, policy };
      }
    }
  }
  return null;
}

async function logOutbound(uid, policyKey, phone, body, sid, type) {
  const id = Date.now() + "_" + Math.random().toString(16).slice(2);
  const updates = {};
  updates[`users/${uid}/messages/${id}`] = {
    at: new Date().toISOString(),
    policyKey,
    direction: "outbound",
    to: phone,
    body,
    sid,
    type
  };
  updates[`users/${uid}/policies/${policyKey}/last_whatsapp_at`] = new Date().toISOString();
  updates[`users/${uid}/policies/${policyKey}/last_whatsapp_sid`] = sid;
  updates[`users/${uid}/policies/${policyKey}/last_whatsapp_type`] = type;
  updates[`users/${uid}/policies/${policyKey}/whatsapp_status`] = type;
  await dbPatch(updates);
}

async function logInboundGeneric(from, body, media = []) {
  const id = Date.now() + "_" + Math.random().toString(16).slice(2);
  const updates = {};
  updates[`twilio_inbound/${id}`] = {
    at: new Date().toISOString(),
    from,
    body,
    media
  };
  await dbPatch(updates);
}

async function createGenericTask(from, title, detail) {
  const id = Date.now() + "_" + Math.random().toString(16).slice(2);
  const updates = {};
  updates[`twilio_tasks/${id}`] = {
    at: new Date().toISOString(),
    from,
    title,
    detail,
    status: "open"
  };
  await dbPatch(updates);
}

function genericAutoReply(bodyRaw, hasMedia) {
  const body = String(bodyRaw || "").trim().toLowerCase();

  if (hasMedia) {
    return "Comprobante recibido. Lo revisaremos y actualizaremos el estatus de tu póliza. Gracias.";
  }

  if (body.includes("pagar") || body === "1" || body.includes("link")) {
    return `Claro. Para pagar o revisar tu póliza AXA entra aquí:

${PAYMENT_LINK}

Ingresa tu número de póliza.

Si aún no aparece, puede estar en intento de cobro automático. Mantén disponible el monto en tu tarjeta. Si no se cobra en aproximadamente 2 semanas después de la emisión, aparecerá el pago en ese enlace.

Después de pagar, envía tu comprobante por este WhatsApp.`;
  }

  if (body.includes("pagado") || body.includes("ya pag")) {
    return "Gracias. Por favor envía tu comprobante por este WhatsApp para actualizar tu póliza.";
  }

  if (body.includes("comprobante") || body === "3") {
    return "Adelante, envía tu comprobante como imagen o PDF en este mismo chat.";
  }

  if (body.includes("asesor") || body.includes("ayuda") || body === "4") {
    return "Listo. Un asesor revisará tu caso y te contactará.";
  }

  return `Te ayudo con tu póliza AXA.

Responde:
PAGAR para recibir el enlace e instrucciones de pago
PAGADO si ya pagaste
COMPROBANTE para enviar evidencia
ASESOR para que te contacte una persona`;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "CarteraPro Twilio Status Simple",
    endpoints: [
      "POST /twilio/webhook",
      "GET /test-send?phone=6621234567",
      "GET /send-policy?poliza=160225945200",
      "GET /run-status-followups?limit=10"
    ]
  });
});

app.get("/test-send", async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ ok: false, error: "Falta phone" });

    const sid = await sendWhatsApp(phone, "Prueba CarteraPro: Twilio WhatsApp conectado.");
    res.json({ ok: true, sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/send-policy", async (req, res) => {
  try {
    const found = await findPolicyByNumber(req.query.poliza);
    if (!found) return res.status(404).json({ ok: false, error: "No encontré póliza" });

    const phone = policyPhone(found.policy);
    if (!phone) return res.status(400).json({ ok: false, error: "La póliza no tiene teléfono" });

    const type = req.query.type || classifyPolicy(found.policy);
    const body = buildMessage(found.policy, type);
    const sid = await sendWhatsApp(phone, body);
    await logOutbound(found.uid, found.policyKey, phone, body, sid, type);

    res.json({ ok: true, sid, type, uid: found.uid, policyKey: found.policyKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/run-status-followups", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || LIMIT), 200);
    const force = String(req.query.force || "") === "1";
    const users = (await dbGet("users")) || {};
    const today = todayISO();
    const sent = [];

    for (const [uid, user] of Object.entries(users)) {
      const policies = user.policies || {};
      for (const [policyKey, policy] of Object.entries(policies)) {
        if (sent.length >= limit) break;

        const phone = policyPhone(policy);
        if (!phone) continue;

        const type = classifyPolicy(policy);

        // Evita enviar recordatorio de pólizas pagadas automáticamente.
        if (type === "pagada" && !force) continue;

        // Evita duplicar el mismo tipo de mensaje el mismo día.
        if (!force &&
            policy.last_whatsapp_followup_date === today &&
            policy.last_whatsapp_type === type) {
          continue;
        }

        const body = buildMessage(policy, type);
        const sid = await sendWhatsApp(phone, body);
        await logOutbound(uid, policyKey, phone, body, sid, type);

        const updates = {};
        updates[`users/${uid}/policies/${policyKey}/last_whatsapp_followup_date`] = today;
        updates[`users/${uid}/policies/${policyKey}/last_whatsapp_type`] = type;
        await dbPatch(updates);

        sent.push({
          uid,
          policyKey,
          poliza: policy.poliza,
          phone,
          type,
          sid
        });
      }
    }

    res.json({ ok: true, sentCount: sent.length, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/twilio/webhook", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    const from = req.body.From || "";
    const bodyRaw = req.body.Body || "";
    const numMedia = Number(req.body.NumMedia || 0);
    const media = [];

    for (let i = 0; i < numMedia; i++) {
      media.push({
        url: req.body[`MediaUrl${i}`],
        contentType: req.body[`MediaContentType${i}`]
      });
    }

    await logInboundGeneric(from, bodyRaw, media);

    if (String(bodyRaw || "").toLowerCase().includes("asesor") || String(bodyRaw || "").trim() === "4") {
      await createGenericTask(from, "Cliente solicita asesor", bodyRaw);
    }

    if (numMedia > 0) {
      await createGenericTask(from, "Comprobante recibido", "Cliente envió comprobante por WhatsApp.");
    }

    twiml.message(genericAutoReply(bodyRaw, numMedia > 0));
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(err);
    twiml.message("Tuvimos un problema procesando tu mensaje. Un asesor revisará tu caso.");
    res.type("text/xml").send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CarteraPro Twilio Status Simple escuchando en puerto ${port}`);
});
