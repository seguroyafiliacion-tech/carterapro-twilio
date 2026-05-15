# CarteraPro Twilio Status Simple

Versión sencilla para que el sistema mande seguimiento automático según estatus de póliza.

## Lo que hace

- Revisa pólizas en Firebase.
- Clasifica cada póliza en:
  - intento_cobro
  - pendiente_pago
  - riesgo_cancelacion
  - cancelada_falta_pago
  - por_vencer
  - pagada
- Envía un WhatsApp diferente según el estatus.
- Si el cliente responde:
  - PAGAR / 1: manda liga de caja AXA e instrucciones.
  - PAGADO / 2: pide comprobante.
  - COMPROBANTE / 3: pide comprobante.
  - ASESOR / 4: crea tarea.
  - Si envía imagen/PDF: registra comprobante recibido.
- No necesita buscar información si el cliente escribe primero. Responde genérico.

## Liga de pago usada

https://cajaaxa.mitec.com.mx/cua/inicio.do?method=loginAgente&perfil=cliente

Mensaje clave:
"Ingresa tu número de póliza. Si aún no aparece, puede estar en intento de cobro automático. Mantén disponible el monto en tu tarjeta. Si no se cobra en aproximadamente 2 semanas después de la emisión, aparecerá el pago en ese enlace. Después de pagar, envía tu comprobante."

## Instalar

```bash
npm install
copy .env.example .env
npm start
```

Mac/Linux:

```bash
cp .env.example .env
npm start
```

## Variables

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
FIREBASE_DB_URL=https://baseportals-default-rtdb.firebaseio.com
AXA_PAYMENT_LINK=https://cajaaxa.mitec.com.mx/cua/inicio.do?method=loginAgente&perfil=cliente
DAILY_LIMIT=50
PORT=3000
```

## Endpoints

### Probar Twilio

```text
/test-send?phone=6621234567
```

### Enviar seguimiento de una póliza

```text
/send-policy?poliza=160225945200
```

Forzar tipo:

```text
/send-policy?poliza=160225945200&type=intento_cobro
/send-policy?poliza=160225945200&type=riesgo_cancelacion
/send-policy?poliza=160225945200&type=cancelada_falta_pago
/send-policy?poliza=160225945200&type=por_vencer
/send-policy?poliza=160225945200&type=pendiente_pago
```

### Enviar seguimientos automáticos

```text
/run-status-followups?limit=10
```

Forzar reenvío:

```text
/run-status-followups?limit=10&force=1
```

### Webhook Twilio

```text
/twilio/webhook
```

Twilio Sandbox:
- When a message comes in:
  - URL: https://TU-SERVIDOR/twilio/webhook
  - Method: POST

## Deploy rápido en Render

1. Sube estos archivos a GitHub.
2. Render > New Web Service.
3. Build command:

```bash
npm install
```

4. Start command:

```bash
npm start
```

5. Agrega variables de entorno.
6. Usa la URL de Render en Twilio.

## Para automatizar diario

En Render puedes usar Cron Job o usar cron-job.org apuntando a:

```text
https://TU-SERVIDOR/run-status-followups?limit=50
```

## Nota

Esta versión es directa y sencilla para prueba. Antes de producción:
- Usar plantillas aprobadas de WhatsApp.
- Validar opt-in.
- Cerrar reglas de Firebase.
- Validar firma de Twilio.


## Corrección importante FIREBASE_DB_URL

En Render debe quedar exactamente así:

```env
FIREBASE_DB_URL=https://baseportals-default-rtdb.firebaseio.com
```

No lo pongas así:

```env
FIREBASE_DB_URL=//baseportals-default-rtdb.firebaseio.com
```

Tampoco agregues `.json` al final.


## Versión API Reply

Esta versión no depende de TwiML para responder WhatsApp.

Flujo:
1. Twilio manda webhook.
2. Servidor responde `OK` de inmediato.
3. Servidor manda respuesta por API con `client.messages.create()`.

Endpoint de prueba:

```text
/reply-test?phone=6622434983
```

o:

```text
/reply-test?to=whatsapp:+5216622434983
```

IMPORTANTE:
`TWILIO_WHATSAPP_FROM` debe ser el número real aprobado que recibió el mensaje:

```env
TWILIO_WHATSAPP_FROM=whatsapp:+52TU_NUMERO_REAL
```


## Corrección importante: responder desde el mismo número que recibió

Esta versión usa `req.body.To` como `from` al responder.

Eso significa:
- Si el cliente escribió al número real aprobado, la respuesta sale desde ese mismo número.
- Si el cliente escribió al Sandbox, la respuesta sale desde Sandbox.
- Evita responder desde otro `TWILIO_WHATSAPP_FROM` diferente, que puede quedar en `queued` y luego fallar.

En logs ahora verás:

```text
INBOUND WHATSAPP { from: cliente, to: numero_twilio }
SENDING BOT REPLY { from: numero_twilio, to: cliente }
```

El valor `from` de `SENDING BOT REPLY` debe ser igual al `to` de `INBOUND WHATSAPP`.
