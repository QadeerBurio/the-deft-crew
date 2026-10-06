// utils/mailer.js
// One place to send email. Works on Railway.
//
// Railway Free/Trial/Hobby plans block outbound SMTP (ports 25/465/587), so
// nodemailer + Hostinger SMTP times out on the live server. This sends over
// HTTPS instead, which is never blocked:
//
//   1. RESEND_API_KEY set  → Resend API   (recommended)
//   2. BREVO_API_KEY set   → Brevo API    (free 300/day)
//   3. otherwise           → SMTP (EMAIL_HOST/PORT/USER/PASS), for local dev
//
// Env:
//   EMAIL_FROM       noreply@gettdc.pk   (must be on a domain verified in Resend/Brevo)
//   EMAIL_FROM_NAME  The Deft Crew       (optional)

const axios = require('axios');

const FROM_EMAIL = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'The Deft Crew';
const TIMEOUT_MS = 15000;

function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.EMAIL_HOST || process.env.EMAIL_USER) return 'smtp';
  return 'none';
}

const htmlToText = (html = '') =>
  html.replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// ── Resend (HTTPS) ──
async function sendResend({ to, subject, html, text }) {
  const res = await axios.post(
    'https://api.resend.com/emails',
    {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || htmlToText(html),
    },
    {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      timeout: TIMEOUT_MS,
    }
  );
  return { id: res.data?.id };
}

// ── Brevo (HTTPS) ──
async function sendBrevo({ to, subject, html, text }) {
  const list = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));
  const res = await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: list,
      subject,
      htmlContent: html,
      textContent: text || htmlToText(html),
    },
    {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      timeout: TIMEOUT_MS,
    }
  );
  return { id: res.data?.messageId };
}

// ── SMTP (local dev only; blocked on Railway Hobby) ──
let smtpTransport = null;
function getSmtp() {
  if (smtpTransport) return smtpTransport;
  const nodemailer = require('nodemailer');
  smtpTransport = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.hostinger.com',
    port: Number(process.env.EMAIL_PORT || 465),
    secure: process.env.EMAIL_SECURE !== 'false',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return smtpTransport;
}

async function sendSmtp({ to, subject, html, text }) {
  const info = await getSmtp().sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject,
    html,
    text: text || htmlToText(html),
  });
  return { id: info.messageId };
}

/**
 * sendMail({ to, subject, html, text? }) → { ok, id, provider } or throws
 */
async function sendMail(msg) {
  const p = provider();
  if (!msg?.to) throw new Error('sendMail: "to" is required');
  if (p === 'none') throw new Error('No email provider configured (set RESEND_API_KEY)');
  if (!FROM_EMAIL) throw new Error('EMAIL_FROM is not set');

  try {
    const r =
      p === 'resend' ? await sendResend(msg) :
      p === 'brevo' ? await sendBrevo(msg) :
      await sendSmtp(msg);
    console.log(`📧 [mail:${p}] sent "${msg.subject}" → ${msg.to} (${r.id || 'no id'})`);
    return { ok: true, id: r.id, provider: p };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ [mail:${p}] failed "${msg.subject}" → ${msg.to}: ${detail}`);
    const e = new Error(`Email send failed (${p}): ${detail}`);
    e.provider = p;
    throw e;
  }
}

// Logs which provider is active at startup. Never blocks or crashes boot.
function logMailerStatus() {
  const p = provider();
  if (p === 'none') {
    console.warn('⚠️  [mail] no provider configured. Set RESEND_API_KEY + EMAIL_FROM.');
  } else if (p === 'smtp') {
    console.log('📧 [mail] using SMTP (fine locally; Railway Hobby blocks SMTP, use RESEND_API_KEY there)');
    getSmtp().verify().then(
      () => console.log('✅ [mail] SMTP ready'),
      (e) => console.error('❌ [mail] SMTP not reachable:', e.message)
    );
  } else {
    console.log(`📧 [mail] using ${p} API, from ${FROM_NAME} <${FROM_EMAIL}>`);
  }
}

module.exports = { sendMail, logMailerStatus, mailProvider: provider };
