# ClearPaid

Get paid from abroad, keep more of it. Built for freelancers in India and other countries where PayPal is less common.

- Send invoices to clients overseas through **PayPal** (sandbox).
- Read bills and emails by **scan, PDF or paste**, with checks before anything is used.
- Read client replies with **AI** (free providers, with a waterfall and a rule-based fallback), and draft replies you approve.
- See what reaches your bank in rupees after fees and conversion, and what waiting costs.

Hackathon prototype. Sandbox only. No real money moves.

## Quick start

```bash
cp .env.example .env        # then fill in your keys (see below)
npm start                   # or: node server/index.js
```

Open http://localhost:3000 (the landing page) or http://localhost:3000/freelancer/index.html (the app).

No keys are needed to try the app. Without PayPal keys, invoices cannot be sent. Without AI keys, replies use rule-based logic.

## Keys you may need

| Key | Needed for | Where to get it |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sending and checking invoices (sandbox) | developer.paypal.com > Apps & Credentials > Sandbox |
| `GROQ_API_KEY` | AI replies (first in the waterfall) | console.groq.com |
| `GEMINI_API_KEY` | AI replies (second) | aistudio.google.com |
| `OPENROUTER_API_KEY` | AI replies (third, free `:free` models) | openrouter.ai |

The AI waterfall tries providers in that order. It moves on when one is missing, rate-limited, slow, or returns nothing usable. If all fail, rules answer. Free-tier limits change often, so check each provider's dashboard. Message text is sent to the provider that answers.

## Tests

```bash
npm test
```

70 tests cover the server routes, the PayPal client (with a fake fetch), the AI waterfall and its fallback, the invoice reader, the money maths, and the KYC checks.

## Structure

| Path | What it is |
|---|---|
| `freelancer/` | **Main app.** Invoices (PayPal), replies (AI), money view (rupees), scan or upload bills |
| `freelancer/lib/parse-invoice.js` | Reads amount, invoice number, due date and client from text |
| `landing/` | Landing page (desktop-first) |
| `legal/` | Privacy policy, terms, disclaimer, security and data page |
| `server/` | Small Node server, no dependencies: static files, PayPal sandbox API, AI waterfall |
| `server/llm.js` | Free LLM providers and the waterfall |
| `server/ai.js` | Reply classification and drafts, with injection handling |
| `kyc/` | Secondary prototype: ID capture checks, OCR, format checks. Not part of the main demo |
| `app/` | Secondary prototype: collections assistant for businesses (mock data) |
| `tests/` | Automated tests (`node --test`) |
| `process/` | Internal working notes. Excluded from git (see `.gitignore`) |

## Honest status

Working and tested:
- Server, PayPal client, AI waterfall and fallback, invoice reader, money maths, KYC checks (unit tests).
- Scan and read of text, PDF text layers and photos, tested in the browser on sample text.

Not yet verified:
- Live PayPal sandbox calls. The endpoints follow PayPal's documented invoicing API, but the code has not been run against a real sandbox account. Test this first.
- AI model names and free limits come from secondary sources. Confirm them on each provider's dashboard.
- Bill reading accuracy on real bills from real clients. Only sample text and a rendered test image have been tested.
- PayPal India fee and currency rules. The fee numbers are estimates from competitor and vendor blogs.

Before any public release: legal review of the legal pages, a real contact address, security review, and a decision on user accounts and data storage. See `legal/security.html`.

## Licence

To be chosen before submission. The repository must have a licence file visible in its About section.
