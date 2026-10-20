// services/events/tickets.js
// Event tickets. Everything here is server side: codes, amounts and event data come from the
// stored registration and event, never from a request.
//
//   issueTickets(id)          once per registration (verified payment, or a free event)
//   applyPaymentToTickets()   reject → cancel; verify again → the same tickets come back
//   deliverTickets(reg, opts) in-app record + push (opens the ticket) + email (Resend)
//   ticketView(reg, event)    what the app / email show (missing fields left out)
//   backfillTickets(opts)     old verified registrations; dry run unless apply; sends nothing
//   ticketPageHtml(view, seat) the public ticket page (GET /api/events/ticket/:pageToken)

const crypto = require('crypto');
const QRCode = require('qrcode');
const { Event, Registration } = require('../../models/Event');
const Notification = require('../../models/Notification');
const { sendMail } = require('../../utils/mailer');
const { sendToUser } = require('../../utils/pushNotification');

// no 0/O or 1/I: codes are read out loud and typed at the door
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const block = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const newTicketCode = () => `TDC-${block()}-${block()}`;
const TICKET_CODE_RE = /^TDC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_SEATS = 50; // per registration (the form already caps it far lower)
const CODE_TRIES = 5;
// the ticket page link: 32 random bytes (43 url-safe characters), never the ticket code
const newPageToken = () => crypto.randomBytes(32).toString('base64url');
const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://the-deft-crew-production.up.railway.app').replace(/\/$/, '');
const ticketPageUrl = (pageToken) => `${PUBLIC_BASE_URL}/api/events/ticket/${pageToken}`;

// old registrations have no payment object: they count as not_required (free)
const paymentStatus = (reg) => reg?.payment?.status || 'not_required';
const hasTicketRight = (reg) => ['verified', 'not_required'].includes(paymentStatus(reg));
const RIGHT_FILTER = { 'payment.status': { $in: ['verified', 'not_required', null] } };

const isCodeClash = (err) =>
  err?.code === 11000 && /tickets\.(code|pageToken)/.test(`${JSON.stringify(err.keyPattern || {})} ${err.message || ''}`);

/**
 * Creates the tickets of one registration, once. The update only matches a registration that
 * still has no tickets, so two verifies at the same time can't both issue.
 * → { issued: true, registration } | { issued: false, reason: 'not_found' | 'no_right' | 'exists', registration }
 */
async function issueTickets(registrationId) {
  for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
    const reg = await Registration.findById(registrationId);
    if (!reg) return { issued: false, reason: 'not_found', registration: null };
    if (!hasTicketRight(reg)) return { issued: false, reason: 'no_right', registration: reg };
    if (reg.tickets?.length) return { issued: false, reason: 'exists', registration: reg };

    const of = Math.max(1, Math.min(MAX_SEATS, Number(reg.ticket?.quantity) || 1));
    const issuedAt = new Date();
    const codes = new Set();
    while (codes.size < of) codes.add(newTicketCode());
    const tickets = [...codes].map((code, i) => ({
      code,
      seat: i + 1,
      of,
      tier: reg.ticket?.tier || undefined,
      status: 'valid',
      issuedAt,
      pageToken: newPageToken(),
    }));

    try {
      const updated = await Registration.findOneAndUpdate(
        { _id: reg._id, 'tickets.0': { $exists: false }, ...RIGHT_FILTER },
        { $set: { tickets, ticketsIssuedAt: issuedAt } },
        { returnDocument: 'after' }
      );
      if (updated) return { issued: true, registration: updated };
      // someone else issued, or the payment changed in between: read again
    } catch (err) {
      if (!isCodeClash(err)) throw err;
      console.warn('[tickets] code clash, trying new codes');
    }
  }
  throw new Error('Could not issue a ticket code. Please try again.');
}

/**
 * Admin payment review, on the loaded document (saved by the caller):
 * reject → valid tickets are cancelled (payment_rejected); verify → those come back.
 * Tickets the admin cancelled by hand stay cancelled. Returns true if anything changed.
 */
function applyPaymentToTickets(reg, action) {
  if (!reg?.tickets?.length) return false;
  let changed = false;
  for (const t of reg.tickets) {
    if (action === 'reject' && t.status === 'valid') {
      t.status = 'cancelled';
      t.cancelReason = 'payment_rejected';
      t.cancelledAt = new Date();
      changed = true;
    } else if (action === 'verify' && t.status === 'cancelled' && t.cancelReason === 'payment_rejected') {
      t.status = 'valid';
      t.cancelReason = undefined;
      t.cancelledAt = undefined;
      changed = true;
    }
  }
  if (changed) reg.markModified('tickets');
  return changed;
}

// ── what the ticket shows ─────────────────────────────────────
const PLACEHOLDERS = new Set(['', 'tba', 'tbd', 'online/venue tbd', 'not provided']);
const real = (v) => {
  const s = v == null ? '' : String(v).trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
};
const isUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim());

/**
 * Plain data for the app, the email and the ticket page. Missing fields are left out, never
 * invented. links: true adds each seat's page link (email / admin only, not the app).
 */
function ticketView(reg, event, { links = false } = {}) {
  const r = typeof reg.toObject === 'function' ? reg.toObject() : reg;
  const ev = event && typeof event.toObject === 'function' ? event.toObject() : event || {};
  const details = ev.details && typeof ev.details === 'object' ? ev.details : {};
  const location = real(ev.location);
  const status = paymentStatus(r);
  const link = [details.onlineLink, details.meetingLink, details.joinLink, location].find((x) => isUrl(x)) || null;
  const view = {
    registrationId: String(r._id),
    eventId: ev._id ? String(ev._id) : r.eventId ? String(r.eventId) : null,
    event: {
      title: real(ev.title),
      category: real(ev.type),
      date: real(ev.date),
      time: real(details.gateOpenTime || details.startTime || details.time),
      venue: location && !isUrl(location) ? location : null,
      city: real(ev.city),
      onlineLink: link,
      organizer: real(ev.organizer),
    },
    attendee: real(r.studentName),
    tier: real(r.ticket?.tier),
    quantity: r.ticket?.quantity || (r.tickets || []).length || 1,
    paymentStatus: status === 'verified' ? 'paid' : 'free',
    amountPaid: status === 'verified' ? Math.max(0, Number(r.payment?.amount) || 0) : 0,
    issuedAt: r.ticketsIssuedAt || null,
    tickets: (r.tickets || []).map((t) => ({
      code: t.code,
      seat: t.seat || null,
      of: t.of || null,
      tier: real(t.tier),
      status: t.status || 'valid',
      ...(links && t.pageToken ? { pageUrl: ticketPageUrl(t.pageToken) } : {}),
    })),
  };
  // drop missing fields so the app hides them
  for (const k of Object.keys(view.event)) if (view.event[k] == null) delete view.event[k];
  for (const k of ['attendee', 'tier', 'issuedAt']) if (view[k] == null) delete view[k];
  return view;
}

// ── email (HTML only; QR drawn as a table so no image is blocked) ──
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function qrTableHtml(text, cell = 6) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  // runs of the same colour share one cell (colspan): small enough for several seats per email
  const rows = [];
  for (let y = 0; y < n; y++) {
    let tds = '';
    let x = 0;
    while (x < n) {
      const dark = modules.get(y, x);
      let run = 1;
      while (x + run < n && modules.get(y, x + run) === dark) run++;
      const span = run > 1 ? ` colspan="${run}"` : '';
      tds += dark ? `<td${span} bgcolor="#111111"></td>` : `<td${span}></td>`;
      x += run;
    }
    rows.push(`<tr height="${cell}" style="height:${cell}px">${tds}</tr>`);
  }
  // one empty row of single cells fixes the column widths in every mail client
  const grid = `<tr height="0">${`<td width="${cell}"></td>`.repeat(n)}</tr>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="border-collapse:collapse;background:#ffffff;margin:0 auto;font-size:0;line-height:0">${grid}${rows.join('')}</table>`;
}

const formatPkr = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

function ticketEmailHtml(view) {
  const ev = view.event || {};
  const row = (label, value) =>
    value ? `<tr><td style="padding:4px 0;color:#6B675E;font-size:13px;width:120px">${esc(label)}</td><td style="padding:4px 0;color:#111111;font-size:14px;font-weight:600">${value}</td></tr>` : '';
  const valid = view.tickets.filter((t) => t.status !== 'cancelled');
  const cards = view.tickets.map((t) => {
    const cancelled = t.status === 'cancelled';
    const seat = t.of > 1 ? `seat ${t.seat} of ${t.of}` : 'admit one';
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#ffffff;border:1px solid #ECE7DB;border-radius:18px">
        <tr><td style="padding:20px;text-align:center">
          <div style="font-size:12px;color:#6B675E;letter-spacing:1px">${esc([t.tier || view.tier, seat].filter(Boolean).join(' · ').toLowerCase())}</div>
          <div style="margin:14px auto;padding:12px;background:#ffffff;display:inline-block;${cancelled ? 'opacity:0.25;' : ''}">${qrTableHtml(t.code)}</div>
          <div style="font-family:Consolas,Menlo,monospace;font-size:20px;font-weight:700;letter-spacing:2px;color:#111111">${esc(t.code)}</div>
          ${cancelled ? '<div style="margin-top:8px;color:#B42318;font-weight:700">cancelled</div>' : ''}
          ${!cancelled && t.pageUrl ? `<div style="margin-top:16px"><a href="${esc(t.pageUrl)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px">download ticket</a></div>` : ''}
        </td></tr>
      </table>`;
  }).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#FAF8F3;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
      <tr><td style="padding:0 0 16px">
        <span style="display:inline-block;background:#F9C349;color:#111111;font-weight:800;font-size:18px;padding:6px 12px;border-radius:10px">tdc<span style="color:#111111">.</span></span>
      </td></tr>
      <tr><td style="background:#111111;border-radius:22px;padding:22px;color:#ffffff">
        <div style="font-size:12px;color:#F9C349;letter-spacing:1px">${esc((ev.category || 'event').toLowerCase())}</div>
        <div style="font-size:22px;font-weight:800;margin-top:6px">${esc((ev.title || 'your event').toLowerCase())}<span style="color:#F9C349">.</span></div>
        <div style="font-size:13px;color:#B8B2A5;margin-top:8px">${esc(valid.length === 1 ? 'your ticket is ready. show the code at the door.' : `your ${valid.length} tickets are ready. show the codes at the door.`)}</div>
      </td></tr>
      <tr><td style="padding:16px 4px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${row('name', esc(view.attendee))}
          ${row('date', esc(ev.date))}
          ${row('time', esc(ev.time))}
          ${row('venue', esc([ev.venue, ev.city].filter(Boolean).join(', ')))}
          ${row('online', ev.onlineLink ? `<a href="${esc(ev.onlineLink)}" style="color:#111111">${esc(ev.onlineLink)}</a>` : '')}
          ${row('paid', view.paymentStatus === 'paid' ? esc(`${formatPkr(view.amountPaid)} · paid`) : 'free')}
        </table>
      </td></tr>
      <tr><td>${cards}</td></tr>
      <tr><td style="padding:8px 4px;color:#6B675E;font-size:12px">this ticket is also in the tdc app: events → mine → download ticket. "download ticket" opens a page you can save as pdf or print. don't forward this email: the link opens your ticket. the qr holds the ticket code only.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// ── delivery ──────────────────────────────────────────────────
const pushText = (view) => {
  const n = view.tickets.filter((t) => t.status === 'valid').length;
  const title = (view.event.title || 'your event').toLowerCase();
  return {
    title: n > 1 ? 'your tickets are ready' : 'your ticket is ready',
    body: `${view.paymentStatus === 'paid' ? 'payment verified. ' : ''}${n > 1 ? `your ${n} tickets` : 'your ticket'} for ${title} ${n > 1 ? 'are' : 'is'} in the app. tap to open.`,
  };
};

// Data every ticket push carries. Old builds read route "Events" (they open events); new
// builds read ticketRegistrationId and open the ticket.
const pushData = (view) => ({
  eventId: view.eventId,
  registrationId: view.registrationId,
  ticketRegistrationId: view.registrationId,
  route: 'Events',
  params: { ticketRegistrationId: view.registrationId },
});

/**
 * Sends the ticket. Never throws.
 *   record: true  → in-app notification record (its own auto push). Used once, at issue.
 *   record: false → push only, no new record (admin re-send).
 *   email: true   → ticket email (the existing mailer: Resend on Railway)
 */
async function deliverTickets(registrationId, { record = false, push = true, email = true } = {}) {
  const out = { push: null, email: null, emailError: null, links: [] };
  try {
    // tickets issued before page links existed get theirs now
    await ensurePageTokens(registrationId);
    const reg = await Registration.findById(registrationId);
    if (!reg || !reg.tickets?.length || !hasTicketRight(reg)) return { ...out, skipped: 'no_ticket' };
    const event = await Event.findById(reg.eventId).select('title type date location city organizer details');
    const view = ticketView(reg, event, { links: true });
    out.links = view.tickets.filter((t) => t.pageUrl).map((t) => ({ code: t.code, status: t.status, url: t.pageUrl }));
    const valid = view.tickets.filter((t) => t.status === 'valid');
    if (!valid.length) return { ...out, skipped: 'all_cancelled' };
    const delivery = {};

    if (push) {
      const { title, body } = pushText(view);
      try {
        if (record) {
          await Notification.create({
            recipient: reg.userId,
            title,
            description: body,
            type: 'Event',
            mood: 'excited',
            metadata: { ...pushData(view), paymentStatus: paymentStatus(reg) },
          });
          out.push = 'sent';
        } else {
          const r = await sendToUser(reg.userId, title, body, { type: 'event', mood: 'excited', ...pushData(view) });
          out.push = r?.sent ? 'sent' : r?.reason || 'not_sent';
        }
        delivery['ticketDelivery.notifiedAt'] = new Date();
      } catch (e) {
        out.push = 'failed';
        console.warn('[tickets] push failed:', e.message);
      }
    }

    if (email) {
      delivery['ticketDelivery.emailTriedAt'] = new Date();
      if (!reg.email) {
        out.email = 'no_email';
        delivery['ticketDelivery.emailStatus'] = 'no_email';
      } else {
        try {
          await sendMail({
            to: reg.email,
            subject: `your tdc ticket: ${view.event.title || 'event'}`,
            html: ticketEmailHtml(view),
          });
          out.email = 'sent';
          delivery['ticketDelivery.emailStatus'] = 'sent';
          delivery['ticketDelivery.emailedAt'] = new Date();
          delivery['ticketDelivery.emailError'] = undefined;
        } catch (e) {
          // never blocks the ticket: stored for the admin (who can re-send) and logged in words
          const reason = describeMailError(e);
          out.email = 'failed';
          out.emailError = reason;
          delivery['ticketDelivery.emailStatus'] = 'failed';
          delivery['ticketDelivery.emailError'] = reason;
          console.warn(`[tickets] ticket email not sent → registration ${reg._id}: ${reason}`);
        }
      }
    }

    if (Object.keys(delivery).length) {
      const $set = {};
      const $unset = {};
      for (const [k, v] of Object.entries(delivery)) {
        if (v === undefined) $unset[k] = 1;
        else $set[k] = v;
      }
      await Registration.updateOne({ _id: reg._id }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
    }
  } catch (e) {
    console.warn('[tickets] delivery failed:', e.message);
    out.error = e.message;
  }
  return out;
}

// The mail error in words for the log and the admin (no keys, no raw provider dumps)
function describeMailError(err) {
  const m = String(err?.message || '');
  if (/No email provider configured/i.test(m)) return 'email is not set up on the server (no RESEND_API_KEY)';
  if (/EMAIL_FROM is not set/i.test(m)) return 'the From address is not set on the server (EMAIL_FROM)';
  if (/domain.*(not verified|verify)|not verified/i.test(m)) return 'the From domain is not verified with the mail service';
  if (/\b(401|403)\b|api key|unauthori[sz]ed|forbidden/i.test(m)) return 'the mail service refused the API key';
  if (/\b429\b|rate limit|too many/i.test(m)) return 'the mail service is limiting sends right now; re-send later';
  if (/\b422\b|invalid.*(to|email|address)/i.test(m)) return 'the email address was refused by the mail service';
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m)) return 'the mail service did not answer in time';
  return `the mail service did not accept the email${m ? ` (${m.replace(/\s+/g, ' ').slice(0, 160)})` : ''}`;
}

/**
 * Every ticket of a registration gets its page token (tickets issued before page links
 * existed). One update per seat, only where the token is still missing: never overwrites a
 * token or a ticket's status. Returns how many were added.
 */
async function ensurePageTokens(registrationId) {
  const reg = await Registration.findById(registrationId);
  if (!reg?.tickets?.length) return 0;
  let added = 0;
  for (let i = 0; i < reg.tickets.length; i++) {
    const t = reg.tickets[i];
    if (t.pageToken) continue;
    for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
      try {
        const r = await Registration.updateOne(
          { _id: reg._id, [`tickets.${i}.code`]: t.code, [`tickets.${i}.pageToken`]: { $exists: false } },
          { $set: { [`tickets.${i}.pageToken`]: newPageToken() } }
        );
        if (r?.modifiedCount) added++;
        break;
      } catch (err) {
        if (!isCodeClash(err)) throw err;
      }
    }
  }
  return added;
}

/** The registration and seat behind a ticket page token, or null. */
async function findByPageToken(pageToken) {
  if (!PAGE_TOKEN_RE.test(String(pageToken || ''))) return null;
  const reg = await Registration.findOne({ 'tickets.pageToken': pageToken });
  const seat = reg?.tickets?.find((t) => t.pageToken === pageToken);
  return reg && seat ? { reg, seat } : null;
}

// QR as inline SVG (one square per dark module; prints sharp, no image request)
function qrSvg(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#ffffff"/><path fill="#111111" d="${d}"/></svg>`;
}

// ── the public ticket page (print / save as pdf) ──────────────
// Only ticket fields: no email, phone, receipt, transaction id or payment accounts.
function ticketPageHtml(view, seat, { nonce = '' } = {}) {
  const ev = view.event || {};
  const off = seat.status !== 'valid' || view.revoked;
  const stateLine = seat.status === 'used' ? 'this ticket was already used' : 'this ticket was cancelled';
  const seatLabel = seat.of > 1 ? `seat ${seat.seat} of ${seat.of}` : 'admit one';
  const rows = [
    ['date', ev.date],
    ['time', ev.time],
    [ev.venue ? 'venue' : 'city', [ev.venue, ev.city].filter(Boolean).join(', ')],
    ['online', ev.onlineLink],
    ['name', view.attendee],
    ['ticket', [seat.tier || view.tier, seatLabel].filter(Boolean).join(' · ').toLowerCase()],
    [view.paymentStatus === 'paid' ? 'paid' : 'price', view.paymentStatus === 'paid' ? `${formatPkr(view.amountPaid)} · paid` : 'free'],
  ].filter(([, v]) => v);
  const qr = off ? '' : qrSvg(seat.code);
  const title = ev.title ? String(ev.title).toLowerCase() : 'your ticket';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(off ? 'ticket cancelled' : `ticket · ${title}`)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#FAF8F3;color:#111111;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{max-width:440px;margin:0 auto;padding:24px 16px 40px}
  .card{background:#fff;border:1px solid #ECE7DB;border-radius:22px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
  .top{background:#111111;color:#fff;padding:22px}
  .row1{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .logo{background:#F9C349;color:#111111;font-weight:800;font-size:17px;padding:5px 11px;border-radius:10px}
  .cat{color:#F9C349;font-size:13px;font-weight:600}
  h1{font-size:25px;line-height:1.2;margin:16px 0 0;font-weight:800;overflow-wrap:anywhere}
  h1 span{color:#F9C349}
  .pill{display:inline-block;margin-top:12px;font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px;background:#E3F3E8;color:#1E6B3A}
  .pill.free{background:#FFF1CC;color:#111111}
  .perf{border-top:2px dashed #ECE7DB;margin:0 18px}
  .body{padding:18px 22px 24px}
  dl{display:grid;grid-template-columns:72px 1fr;gap:8px 12px;margin:0;font-size:14px}
  dt{color:#6B675E}
  dd{margin:0;font-weight:600;overflow-wrap:anywhere}
  .qr{width:200px;height:200px;margin:22px auto 0;padding:12px;border:1px solid #ECE7DB;border-radius:16px;background:#fff}
  .qr svg{width:100%;height:100%;display:block}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:3px;text-align:center;margin-top:14px}
  .off{margin-top:18px;text-align:center;color:#B42318;font-weight:800;font-size:18px}
  .note{color:#6B675E;font-size:12.5px;text-align:center;margin-top:16px}
  .btn{display:block;width:100%;margin-top:18px;background:#111111;color:#fff;border:0;border-radius:14px;padding:15px;font-size:16px;font-weight:700;cursor:pointer}
  .btn:focus-visible{outline:3px solid #F9C349;outline-offset:2px}
  @page{size:A5 portrait;margin:12mm}
  @media print{
    body{background:#fff}
    .wrap{padding:0;max-width:none}
    .btn,.note.screen{display:none}
    .card{border-color:#ccc}
  }
</style></head>
<body><main class="wrap">
  <article class="card" aria-label="ticket">
    <div class="top">
      <div class="row1"><span class="logo">tdc.</span>${ev.category ? `<span class="cat">${esc(String(ev.category).toLowerCase())}</span>` : ''}</div>
      <h1>${esc(title)}<span>.</span></h1>
      ${off ? '' : `<span class="pill ${view.paymentStatus === 'paid' ? '' : 'free'}">${view.paymentStatus === 'paid' ? 'paid' : 'free'}</span>`}
    </div>
    <div class="perf" aria-hidden="true"></div>
    <div class="body">
      ${off
        ? `<p class="off" role="status">${esc(stateLine)}</p><p class="note">it won't get you in. open the tdc app for your current tickets.</p>`
        : `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="qr" role="img" aria-label="qr code for ${esc(seat.code)}">${qr}</div>
      <div class="code">${esc(seat.code)}</div>
      <p class="note">show this qr or the code at the door.</p>`}
    </div>
  </article>
  ${off ? '' : `<button class="btn" id="print" type="button">download / print</button>
  <p class="note screen">choose "save as pdf" in the print dialog to keep a copy.</p>
  <script nonce="${esc(nonce)}">document.getElementById('print').addEventListener('click',function(){window.print()});</script>`}
</main></body></html>`;
}

const ticketNotFoundHtml = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ticket not found</title>
<style>body{margin:0;background:#FAF8F3;color:#111;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}main{max-width:440px;margin:0 auto;padding:64px 16px;text-align:center}b{background:#F9C349;padding:5px 11px;border-radius:10px}</style></head>
<body><main><b>tdc.</b><h1 style="font-size:22px;margin-top:24px">ticket not found.</h1><p style="color:#6B675E">check the link in your email, or open the tdc app.</p></main></body></html>`;

/** Issue (if due) and send the first time. For the review / register routes. Never throws. */
async function issueAndDeliver(registrationId) {
  try {
    const r = await issueTickets(registrationId);
    if (r.issued) {
      // not awaited by callers that must answer fast; errors are logged inside
      return { issued: true, delivery: deliverTickets(registrationId, { record: true }) };
    }
    return { issued: false, reason: r.reason };
  } catch (e) {
    console.warn('[tickets] issue failed:', e.message);
    return { issued: false, reason: 'error' };
  }
}

/**
 * Old registrations with a ticket right but no tickets. Sends nothing.
 *   apply false → counts only (dry run)
 *   includeFree → also free (not_required) registrations, not just verified payments
 */
async function backfillTickets({ apply = false, includeFree = false, limit = 5000 } = {}) {
  const noTickets = { 'tickets.0': { $exists: false } };
  // tickets issued before page links existed
  const noLink = { 'tickets.0': { $exists: true }, tickets: { $elemMatch: { pageToken: { $exists: false } } } };
  const [verified, free, withoutLink] = await Promise.all([
    Registration.countDocuments({ ...noTickets, 'payment.status': 'verified' }),
    Registration.countDocuments({ ...noTickets, 'payment.status': { $in: ['not_required', null] } }),
    Registration.countDocuments(noLink),
  ]);
  const report = {
    dryRun: !apply, includeFree: !!includeFree, verified, free, wouldIssue: verified + (includeFree ? free : 0), issued: 0, failed: 0,
    registrationsWithoutLink: withoutLink, linksAdded: 0,
  };
  if (!apply) return report;

  // page links for existing tickets (sends nothing)
  const linkRows = await Registration.find(noLink).select('_id').limit(limit);
  for (const row of linkRows) {
    try {
      report.linksAdded += await ensurePageTokens(row._id);
    } catch (e) {
      report.failed++;
      console.warn('[tickets] link backfill failed for', String(row._id), e.message);
    }
  }

  const statuses = includeFree ? ['verified', 'not_required', null] : ['verified'];
  const rows = await Registration.find({ ...noTickets, 'payment.status': { $in: statuses } }).select('_id').limit(limit);
  for (const row of rows) {
    try {
      const r = await issueTickets(row._id);
      if (r.issued) report.issued++;
    } catch (e) {
      report.failed++;
      console.warn('[tickets] backfill failed for', String(row._id), e.message);
    }
  }
  return report;
}

module.exports = {
  newTicketCode,
  TICKET_CODE_RE,
  hasTicketRight,
  issueTickets,
  applyPaymentToTickets,
  ticketView,
  ticketEmailHtml,
  qrTableHtml,
  deliverTickets,
  issueAndDeliver,
  backfillTickets,
  ensurePageTokens,
  findByPageToken,
  ticketPageHtml,
  ticketNotFoundHtml,
  ticketPageUrl,
  describeMailError,
  PAGE_TOKEN_RE,
};
