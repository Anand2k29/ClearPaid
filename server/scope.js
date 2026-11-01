// Scope gate: decides whether a question is about ClearPaid's job (invoices, payments, clients, money, proof).
// Off-topic or instruction-like questions are refused without calling any model, which saves quota and
// keeps answers on subject. This is a deterministic rule check, so the same input always gets the same answer.
const IN_SCOPE = [
  /\binvoices?\b/i, /\bbills?\b/i, /\bpaid\b/i, /\bpay(ment|ments|ing|s)?\b/i, /\bpaypal\b/i,
  /\bclients?\b/i, /\bcustomers?\b/i, /\bfreelanc\w*/i, /\bcollaborat\w*/i, /\bprojects?\b/i, /\bshares?\b/i,
  /\brupees?\b|\binr\b|₹|\bdollars?\b|\busd\b|\$/i, /\bfees?\b/i, /\bexchange\b|\bconver(t|sion)\b/i,
  /\bwithdraw\w*/i, /\bbank\b/i, /\bfirc\b|\bebrc\b|\bexport\b/i, /\bproof\b|\bqr\b/i,
  /\breply\b|\breplies\b|\bmessage\b|\bremind\w*/i, /\bdue\b|\boverdue\b|\bdeadline\b/i,
  /\bledger\b|\bstatement\b|\baccountant\b|\bgst\b|\btax\w*/i, /\bwaiting\b|\blate\b/i
];

// Phrases that try to change the assistant's role or rules. Refused outright.
const OFF_LIMITS = [
  /ignore\b.*\b(rules|instructions|previous|prompt|system)/i,
  /\b(system|developer)\s*(prompt|message|override|mode)\b/i,
  /\byou are now\b|\bact as\b|\bpretend\b/i,
  /\breveal\b.*\b(prompt|key|token|secret|password)\b/i
];

const MAX_QUESTION = 500;

// Returns { allowed: true } or { allowed: false, reason }.
function checkScope(question) {
  const text = String(question || "").trim();
  if (!text) return { allowed: false, reason: "empty" };
  if (text.length > MAX_QUESTION) return { allowed: false, reason: "too long" };
  if (OFF_LIMITS.some(p => p.test(text))) return { allowed: false, reason: "off-limits request" };
  if (!IN_SCOPE.some(p => p.test(text))) return { allowed: false, reason: "off-topic" };
  return { allowed: true };
}

const REFUSALS = {
  empty: "Please type a question about your invoices, payments or clients.",
  "too long": "That question is too long. Please ask one thing at a time.",
  "off-limits request": "I can only help with ClearPaid tasks: invoices, payments, clients, proof and money.",
  "off-topic": "I can only help with ClearPaid tasks: invoices, payments, clients, proof and money. Try asking about one of those."
};

function refusalFor(reason) {
  return REFUSALS[reason] || REFUSALS["off-topic"];
}

// Checks a model's answer before it reaches the user. Rejects empty, oversized, or role-breaking output.
const MAX_ANSWER = 1200;
function validAnswer(text) {
  const t = String(text || "").trim();
  if (!t || t.length > MAX_ANSWER) return false;
  if (/\b(as an ai|i am now|my system prompt)\b/i.test(t)) return false;
  return true;
}

module.exports = { checkScope, refusalFor, validAnswer, MAX_QUESTION, MAX_ANSWER };
