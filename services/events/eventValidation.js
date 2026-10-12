// services/events/eventValidation.js
// Validation for the events v2 fields (details, registrationForm, fee, ticketTiers,
// paymentAccounts, capacity, registrationCloses) and for registration answers.
// Prices and amounts are whole PKR (non-negative integers).
const { getTemplate, BASE_REGISTRATION, FIELD_TYPES } = require("../../config/eventCategories");

const MAX_PKR = 10000000; // 1 crore: sanity cap for any single price / fee
const LIMITS = { text: 200, textarea: 2000, url: 500, listItems: 30, listItem: 200, label: 80, help: 200, option: 60, options: 30 };

const isInt = (n) => Number.isInteger(n);
const toNum = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
const str = (v) => (v == null ? "" : String(v)).trim();

// 03XXXXXXXXX; also accepts +92 / 92 / spaces / dashes and normalises to 03XXXXXXXXX
function normalizePkMobile(v) {
  let s = str(v).replace(/[\s-]/g, "");
  if (/^\+92/.test(s)) s = "0" + s.slice(3);
  else if (/^92\d{10}$/.test(s)) s = "0" + s.slice(2);
  return /^03\d{9}$/.test(s) ? s : null;
}

// PK IBAN: PK + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 chars, mod-97 = 1
function normalizePkIban(v) {
  const s = str(v).replace(/\s+/g, "").toUpperCase();
  if (!/^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(s)) return null;
  const moved = s.slice(4) + s.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1 ? s : null;
}

const isEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(str(v));
const isHttpUrl = (v) => {
  const s = str(v);
  if (s.length > LIMITS.url) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

// Cloudinary clouds the app / admin upload to (receipts, files)
const CLOUDINARY_CLOUDS = [...new Set(["decaxpera", process.env.CLOUDINARY_NAME].filter(Boolean).map((c) => String(c).toLowerCase()))];
function isProjectCloudinaryUrl(v) {
  const s = str(v);
  if (s.length > LIMITS.url) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com") return false;
    const cloud = u.pathname.split("/")[1]?.toLowerCase();
    return CLOUDINARY_CLOUDS.includes(cloud);
  } catch {
    return false;
  }
}

// ── one value against one field definition ─────────────────────
// returns { ok, value, error }
function checkField(field, raw, ctx = {}) {
  const label = field.label || field.key;
  const empty = raw == null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0);
  if (empty) return field.required ? { ok: false, error: `${label} is required` } : { ok: true, value: undefined };

  switch (field.type) {
    case "text":
    case "textarea": {
      if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, error: `${label} must be text` };
      const s = str(raw);
      const max = field.type === "text" ? LIMITS.text : LIMITS.textarea;
      if (s.length > max) return { ok: false, error: `${label} is too long (max ${max} characters)` };
      return { ok: true, value: s };
    }
    case "number": {
      const n = toNum(raw);
      if (typeof n !== "number" || !isInt(n) || n < 0 || n > MAX_PKR) return { ok: false, error: `${label} must be a whole number` };
      return { ok: true, value: n };
    }
    case "select": {
      const opts = field.options && field.options.length && !String(field.options[0]).startsWith("fromEvent:") ? field.options : ctx.options || [];
      const s = str(raw);
      if (!opts.includes(s)) return { ok: false, error: `${label} must be one of: ${opts.join(", ")}` };
      return { ok: true, value: s };
    }
    case "multiselect": {
      if (!Array.isArray(raw)) return { ok: false, error: `${label} must be a list` };
      const vals = raw.map(str);
      const bad = vals.filter((v) => !(field.options || []).includes(v));
      if (bad.length) return { ok: false, error: `${label} has an invalid choice: ${bad[0]}` };
      return { ok: true, value: [...new Set(vals)] };
    }
    case "list": {
      const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n/) : null;
      if (!items) return { ok: false, error: `${label} must be a list` };
      const vals = items.map(str).filter(Boolean);
      if (vals.length > LIMITS.listItems) return { ok: false, error: `${label} has too many items (max ${LIMITS.listItems})` };
      if (vals.some((v) => v.length > LIMITS.listItem)) return { ok: false, error: `${label} has an item that is too long` };
      if (field.required && !vals.length) return { ok: false, error: `${label} is required` };
      return { ok: true, value: vals };
    }
    case "date": {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return { ok: false, error: `${label} must be a date` };
      return { ok: true, value: d.toISOString() };
    }
    case "time": {
      const s = str(raw);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return { ok: false, error: `${label} must be a time like 18:30` };
      return { ok: true, value: s };
    }
    case "url":
      return isHttpUrl(raw) ? { ok: true, value: str(raw) } : { ok: false, error: `${label} must be a link starting with https://` };
    case "file":
      return isProjectCloudinaryUrl(raw) ? { ok: true, value: str(raw) } : { ok: false, error: `${label} must be an uploaded file` };
    case "phone": {
      const p = normalizePkMobile(raw);
      return p ? { ok: true, value: p } : { ok: false, error: `${label} must be a Pakistani mobile number like 03XXXXXXXXX` };
    }
    case "email":
      return isEmail(raw) && str(raw).length <= 254 ? { ok: true, value: str(raw).toLowerCase() } : { ok: false, error: `${label} must be an email address` };
    default:
      return { ok: false, error: `${label} has an unknown type` };
  }
}

// ── Event.details against the category's createFields (store: "details") ──
function validateDetails(type, details) {
  if (details == null) return { value: undefined, errors: [] };
  if (typeof details !== "object" || Array.isArray(details)) return { value: undefined, errors: ["details must be an object"] };
  const fields = getTemplate(type).createFields.filter((x) => x.store === "details");
  const known = new Set(fields.map((x) => x.key));
  const errors = Object.keys(details).filter((k) => !known.has(k)).map((k) => `details.${k} is not a field of this category`);
  const value = {};
  for (const field of fields) {
    const r = checkField(field, details[field.key]);
    if (!r.ok) errors.push(r.error);
    else if (r.value !== undefined) value[field.key] = r.value;
  }
  if (value.teamSizeMin && value.teamSizeMax && value.teamSizeMin > value.teamSizeMax) errors.push("Minimum team size can't be more than the maximum");
  return { value, errors };
}

// ── registrationForm definition (editable by creator / admin) ──
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
function validateRegistrationForm(form) {
  if (!Array.isArray(form)) return { value: undefined, errors: ["registrationForm must be a list of fields"] };
  if (form.length > 30) return { value: undefined, errors: ["registrationForm has too many fields (max 30)"] };
  const errors = [];
  const seen = new Set();
  const value = [];
  for (const raw of form) {
    const key = str(raw?.key);
    if (!KEY_RE.test(key)) { errors.push(`registrationForm: invalid key "${key}"`); continue; }
    if (seen.has(key)) { errors.push(`registrationForm: duplicate key "${key}"`); continue; }
    seen.add(key);
    const type = str(raw.type);
    if (!FIELD_TYPES.includes(type)) { errors.push(`registrationForm.${key}: unknown type "${type}"`); continue; }
    const options = Array.isArray(raw.options) ? raw.options.map(str).filter(Boolean) : [];
    if (options.length > LIMITS.options || options.some((o) => o.length > LIMITS.option)) { errors.push(`registrationForm.${key}: too many or too long options`); continue; }
    if ((type === "select" || type === "multiselect") && !options.length) { errors.push(`registrationForm.${key}: needs options`); continue; }
    const base = BASE_REGISTRATION.find((b) => b.key === key);
    const store = base ? base.store : key === "ticketTier" || key === "quantity" ? "ticket" : "answers";
    value.push({
      key,
      label: str(raw.label).slice(0, LIMITS.label) || key,
      type: base ? base.type : type,
      required: base && base.required ? true : !!raw.required,
      options,
      helpText: str(raw.helpText).slice(0, LIMITS.help),
      store,
    });
  }
  // the base fields are always on the form
  for (const b of BASE_REGISTRATION.slice().reverse()) if (!seen.has(b.key)) value.unshift({ ...b });
  return { value, errors };
}

// ── money / tickets / payment accounts ─────────────────────────
function validateAmount(v, label) {
  const n = toNum(v);
  if (typeof n !== "number" || !isInt(n) || n < 0 || n > MAX_PKR) return { error: `${label} must be a whole number of rupees (0 or more)` };
  return { value: n };
}

function validateTiers(tiers, existingTiers = []) {
  if (!Array.isArray(tiers)) return { errors: ["ticketTiers must be a list"] };
  if (tiers.length > 10) return { errors: ["ticketTiers: max 10 tiers"] };
  const errors = [];
  const names = new Set();
  const value = tiers.map((t, i) => {
    const name = str(t?.name);
    if (!name || name.length > 60) errors.push(`Ticket tier ${i + 1}: name is required (max 60 characters)`);
    if (names.has(name.toLowerCase())) errors.push(`Ticket tier "${name}" is listed twice`);
    names.add(name.toLowerCase());
    const price = validateAmount(t?.price ?? 0, `Ticket tier "${name}" price`);
    if (price.error) errors.push(price.error);
    const qty = toNum(t?.quantity);
    if (typeof qty !== "number" || !isInt(qty) || qty < 1 || qty > 100000) errors.push(`Ticket tier "${name}": quantity must be a whole number from 1`);
    const mps = toNum(t?.maxPerStudent ?? 1);
    if (typeof mps !== "number" || !isInt(mps) || mps < 1 || mps > 20) errors.push(`Ticket tier "${name}": max per student must be 1 to 20`);
    const old = existingTiers.find((o) => String(o.name).toLowerCase() === name.toLowerCase());
    const sold = old?.sold || 0;
    if (isInt(qty) && qty < sold) errors.push(`Ticket tier "${name}": ${sold} already taken, quantity can't be lower`);
    return { name, price: price.value ?? 0, quantity: qty, maxPerStudent: mps, sold, remaining: isInt(qty) ? qty - sold : 0 };
  });
  for (const old of existingTiers) {
    if ((old.sold || 0) > 0 && !names.has(String(old.name).toLowerCase())) errors.push(`Ticket tier "${old.name}" has registrations and can't be removed`);
  }
  return { value, errors };
}

const METHODS = ["easypaisa", "jazzcash", "bank"];
function validateAccounts(list) {
  if (!Array.isArray(list)) return { errors: ["paymentAccounts must be a list"] };
  if (list.length > 5) return { errors: ["paymentAccounts: max 5 accounts"] };
  const errors = [];
  const value = list.map((a, i) => {
    const n = `Payment account ${i + 1}`;
    const method = str(a?.method).toLowerCase();
    if (!METHODS.includes(method)) errors.push(`${n}: method must be easypaisa, jazzcash or bank`);
    const out = {
      method,
      accountTitle: str(a?.accountTitle).slice(0, 80),
      accountNumber: str(a?.accountNumber).slice(0, 40),
      bankName: str(a?.bankName).slice(0, 80),
      iban: "",
      note: str(a?.note).slice(0, 200),
    };
    if (method === "easypaisa" || method === "jazzcash") {
      const m = normalizePkMobile(a?.accountNumber);
      if (!m) errors.push(`${n}: ${method} number must be a Pakistani mobile number like 03XXXXXXXXX`);
      else out.accountNumber = m;
    }
    if (method === "bank") {
      if (!out.bankName) errors.push(`${n}: bank name is required`);
      if (!out.accountTitle) errors.push(`${n}: account title is required`);
      if (str(a?.iban)) {
        const iban = normalizePkIban(a.iban);
        if (!iban) errors.push(`${n}: IBAN must be a valid 24-character Pakistani IBAN`);
        else out.iban = iban;
      }
      if (!out.accountNumber && !out.iban) errors.push(`${n}: account number or IBAN is required`);
    }
    return out;
  });
  return { value, errors };
}

const isPaid = (fee, tiers) => (fee?.amount || 0) > 0 || (tiers || []).some((t) => (t.price || 0) > 0);

// ── create / update: the v2 fields ────────────────────────────
// body: request body. existing: the Event doc (update) or null (create).
// returns { set, errors } — set holds only the fields to write.
function validateEventV2(body, existing) {
  const errors = [];
  const set = {};
  const type = body.type ?? existing?.type;

  if (body.details !== undefined) {
    const d = validateDetails(type, body.details);
    errors.push(...d.errors);
    if (!d.errors.length) set.details = d.value;
  } else if (existing && body.type !== undefined && existing.details && Object.keys(existing.details).length) {
    // category changed, old details kept: they must fit the new category
    const d = validateDetails(type, existing.details);
    if (d.errors.length) errors.push("Send details for the new category (the old ones don't fit it)");
  }

  if (body.registrationForm !== undefined && body.registrationForm !== null) {
    const r = validateRegistrationForm(body.registrationForm);
    errors.push(...r.errors);
    if (!r.errors.length) set.registrationForm = r.value;
  }

  if (body.fee !== undefined && body.fee !== null) {
    const amount = typeof body.fee === "object" ? body.fee.amount : body.fee;
    const a = validateAmount(amount ?? 0, "Fee");
    if (a.error) errors.push(a.error);
    else set.fee = { amount: a.value, currency: "PKR" };
  }

  if (body.ticketTiers !== undefined && body.ticketTiers !== null) {
    const t = validateTiers(body.ticketTiers, existing?.ticketTiers || []);
    errors.push(...t.errors);
    if (!t.errors.length) set.ticketTiers = t.value;
  }

  if (body.paymentAccounts !== undefined && body.paymentAccounts !== null) {
    const p = validateAccounts(body.paymentAccounts);
    errors.push(...p.errors);
    if (!p.errors.length) set.paymentAccounts = p.value;
  }

  if (body.capacity !== undefined) {
    if (body.capacity === null || body.capacity === "") set.capacity = null;
    else {
      const c = toNum(body.capacity);
      if (typeof c !== "number" || !isInt(c) || c < 1 || c > 1000000) errors.push("Capacity must be a whole number from 1, or empty for unlimited");
      else if (existing && c < (existing.registeredCount || 0)) errors.push(`Capacity can't be lower than the ${existing.registeredCount} already registered`);
      else set.capacity = c;
    }
  }

  if (body.registrationCloses !== undefined) {
    if (body.registrationCloses === null || body.registrationCloses === "") set.registrationCloses = null;
    else {
      const d = new Date(body.registrationCloses);
      if (Number.isNaN(d.getTime())) errors.push("Registration closes must be a date");
      else set.registrationCloses = d;
    }
  }

  // paid → at least one payment account (on the effective, merged values)
  const fee = set.fee ?? existing?.fee;
  const tiers = set.ticketTiers ?? existing?.ticketTiers;
  const accounts = set.paymentAccounts ?? existing?.paymentAccounts ?? [];
  if (isPaid(fee, tiers) && !accounts.length) errors.push("A paid event needs at least one payment account (Easypaisa, JazzCash or bank)");

  return { set, errors };
}

// old text fields (prize, teamSize, deadline) for old app builds, from the new values
function legacyText(body, set) {
  const out = {};
  const d = set.details || {};
  const pkr = (n) => `PKR ${Number(n).toLocaleString("en-US")}`;
  if (!str(body.prize) && d.prizePool) out.prize = pkr(d.prizePool);
  if (!str(body.teamSize)) {
    if (d.teamSizeMin && d.teamSizeMax) out.teamSize = `${d.teamSizeMin}-${d.teamSizeMax} Members`;
    else if (d.mode === "Solo") out.teamSize = "Solo";
    else if (d.teamSizeMax) out.teamSize = `Up to ${d.teamSizeMax} Members`;
  }
  if (!str(body.deadline) && set.registrationCloses) {
    out.deadline = `Register by ${set.registrationCloses.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Karachi" })}`;
  }
  return out;
}

// a request that uses the v2 create form (else: legacy create → today's form)
const isV2Body = (body) => body.formVersion === 2 || body.details !== undefined || body.registrationForm !== undefined;

module.exports = {
  MAX_PKR,
  normalizePkMobile,
  normalizePkIban,
  isProjectCloudinaryUrl,
  checkField,
  validateDetails,
  validateRegistrationForm,
  validateTiers,
  validateAccounts,
  validateEventV2,
  legacyText,
  isPaid,
  isV2Body,
};
