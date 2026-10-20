// services/events/tickets.js
// Event tickets. Everything here is server side: codes, amounts and event data come from the
// stored registration and event, never from a request.
//
//   issueTickets(id)          once per registration (verified payment, or a free event)
//   applyPaymentToTickets()   reject → cancel; verify again → the same tickets come back
//   deliverTickets(reg, opts) in-app record + push (opens the ticket) + email (Resend)
//   ticketView(reg, event)    what the app / email show (missing fields left out)
//   backfillTickets(opts)     old verified registrations; dry run unless apply; sends nothing

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

// old registrations have no payment object: they count as not_required (free)
const paymentStatus = (reg) => reg?.payment?.status || 'not_required';
const hasTicketRight = (reg) => ['verified', 'not_required'].includes(paymentStatus(reg));
const RIGHT_FILTER = { 'payment.status': { $in: ['verified', 'not_required', null] } };

const isCodeClash = (err) =>
  err?.code === 11000 && /tickets\.code/.test(`${JSON.stringify(err.keyPattern || {})} ${err.message || ''}`);

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

/** Plain data for the app and the email. Missing fields are left out, never invented. */
function ticketView(reg, event) {
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
      <tr><td style="padding:8px 4px;color:#6B675E;font-size:12px">this ticket is also in the tdc app: events → mine → my ticket. the qr holds the ticket code only.</td></tr>
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
  const out = { push: null, email: null };
  try {
    const reg = await Registration.findById(registrationId);
    if (!reg || !reg.tickets?.length || !hasTicketRight(reg)) return { ...out, skipped: 'no_ticket' };
    const event = await Event.findById(reg.eventId).select('title type date location city organizer details');
    const view = ticketView(reg, event);
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
      if (!reg.email) {
        out.email = 'no_email';
      } else {
        try {
          await sendMail({
            to: reg.email,
            subject: `your tdc ticket: ${view.event.title || 'event'}`,
            html: ticketEmailHtml(view),
          });
          out.email = 'sent';
          delivery['ticketDelivery.emailedAt'] = new Date();
          delivery['ticketDelivery.emailError'] = undefined;
        } catch (e) {
          out.email = 'failed';
          delivery['ticketDelivery.emailError'] = String(e.message || 'failed').slice(0, 300);
          console.warn('[tickets] email failed:', e.message);
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
  const [verified, free] = await Promise.all([
    Registration.countDocuments({ ...noTickets, 'payment.status': 'verified' }),
    Registration.countDocuments({ ...noTickets, 'payment.status': { $in: ['not_required', null] } }),
  ]);
  const report = { dryRun: !apply, includeFree: !!includeFree, verified, free, wouldIssue: verified + (includeFree ? free : 0), issued: 0, failed: 0 };
  if (!apply) return report;

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
};
