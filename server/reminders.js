// Payment reminders for invoices that are past their due date and still unpaid.
// The app finds and prepares them. Nothing is sent until the freelancer approves. Each invoice gets at most
// one reminder per MIN_GAP_DAYS, and approvals are capped per day, so a reminder cannot be spammed.
const DAY = 86400000;
const MIN_GAP_DAYS = 7;
const DEFAULT_DAILY_CAP = 5;

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isDueDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Adds days to a YYYY-MM-DD date, returning YYYY-MM-DD.
function addDaysIso(dateIso, days) {
  const [y, m, d] = dateIso.split("-").map(Number);
  return iso(new Date(y, m - 1, d + days));
}

// Invoices that are sent, unpaid, past due, and not reminded recently. Oldest due first.
function findOverdue(invoices, today, { now = today.getTime(), minGapDays = MIN_GAP_DAYS } = {}) {
  const todayIso = iso(today);
  return invoices
    .filter(inv => inv.status === "SENT" && isDueDate(inv.dueDate) && inv.dueDate < todayIso)
    .filter(inv => !inv.lastRemindedAt || now - Date.parse(inv.lastRemindedAt) >= minGapDays * DAY)
    .map(inv => ({
      id: inv.id,
      number: inv.number,
      clientName: inv.clientName,
      clientEmail: inv.customerEmail,
      amountUsd: inv.amount,
      dueDate: inv.dueDate,
      daysLate: Math.round((Date.parse(todayIso + "T00:00:00") - Date.parse(inv.dueDate + "T00:00:00")) / DAY),
      lastRemindedAt: inv.lastRemindedAt || null
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// The reminder wording. It states only facts the app holds: the invoice, the amount and the due date.
function reminderText(r) {
  return `Hi ${r.clientName || "there"}, a friendly reminder that invoice ${r.number} for $${Number(r.amountUsd).toFixed(2)} was due on ${r.dueDate}. ` +
    "You can pay it through the PayPal invoice we sent you. If you have already paid, please ignore this message. Thank you.";
}

// Sends one approved reminder through PayPal. Throws with a clear message on any refusal.
async function approveReminder(invoiceId, { store, paypal, now = Date.now(), dailyCap = DEFAULT_DAILY_CAP }) {
  const inv = store.get(invoiceId);
  if (!inv) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  if (inv.status !== "SENT") throw Object.assign(new Error("Only sent, unpaid invoices can be reminded."), { status: 409 });
  if (!isDueDate(inv.dueDate) || inv.dueDate >= iso(new Date(now))) {
    throw Object.assign(new Error("This invoice is not past its due date yet."), { status: 409 });
  }
  if (inv.lastRemindedAt && now - Date.parse(inv.lastRemindedAt) < MIN_GAP_DAYS * DAY) {
    throw Object.assign(new Error(`This invoice was reminded less than ${MIN_GAP_DAYS} days ago.`), { status: 409 });
  }
  const today = iso(new Date(now));
  const sentToday = store.all().filter(i => i.lastRemindedAt && iso(new Date(Date.parse(i.lastRemindedAt))) === today).length;
  if (sentToday >= dailyCap) {
    throw Object.assign(new Error(`Daily reminder limit of ${dailyCap} reached. Try again tomorrow.`), { status: 429 });
  }
  const record = { id: inv.id, number: inv.number, clientName: inv.clientName, amountUsd: inv.amount, dueDate: inv.dueDate };
  await paypal.remindInvoice(inv.id, reminderText(record));
  store.upsert(inv.id, { lastRemindedAt: new Date(now).toISOString(), reminderCount: (inv.reminderCount || 0) + 1 });
  return { sent: true, invoiceId: inv.id, number: inv.number };
}

// Snoozing a reminder reuses the same weekly gap, without sending anything.
function snoozeReminder(invoiceId, { store, now = Date.now() }) {
  const inv = store.get(invoiceId);
  if (!inv) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  store.upsert(inv.id, { lastRemindedAt: new Date(now).toISOString() });
  return { snoozed: true, invoiceId: inv.id };
}

module.exports = { isoDate: iso, findOverdue, reminderText, approveReminder, snoozeReminder, addDaysIso, isDueDate, MIN_GAP_DAYS, DEFAULT_DAILY_CAP };
