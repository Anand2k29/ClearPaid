# ClearPaid

**Get paid by clients abroad, and know exactly what reaches your bank.**

ClearPaid is a web app for freelancers and small teams, built for the PayPal "Build What's Next" hackathon. It helps you:

- send invoices to clients overseas through **PayPal** (sandbox),
- read bills and emails by **scan, PDF, photo or paste**, and check each field before using it,
- read client replies with **AI** (free providers, with a rule-based fallback) and approve every reply before it goes out,
- **dictate** a reply in English, or upload a voice note,
- send a **signed proof** of an invoice to a client as a QR code or link,
- split one client project between several freelancers, each invoiced for their own share,
- send **payment reminders** for overdue invoices, once you approve them,
- see what reaches your bank in rupees after fees and currency conversion, and export a **monthly ledger** for your accountant.

> ClearPaid is a hackathon prototype. It runs on the **PayPal sandbox only**. No real money moves through it. Estimates are not financial or tax advice.

---

## Contents

1. [Status](#status)
2. [How it works](#how-it-works)
3. [Quick start](#quick-start)
4. [Environment settings (.env)](#environment-settings-env)
5. [Setting up PayPal (sandbox)](#setting-up-paypal-sandbox)
6. [Setting up free AI providers](#setting-up-free-ai-providers)
7. [Using the app](#using-the-app)
8. [API reference](#api-reference)
9. [Security model](#security-model)
10. [Project structure](#project-structure)
11. [Tests](#tests)
12. [Deployment](#deployment)
13. [Troubleshooting](#troubleshooting)
14. [Roadmap](#roadmap)
15. [Licence and credits](#licence-and-credits)

---

## Status

| Area | State |
|---|---|
| Invoices through PayPal (create, send, status) | Built. Needs sandbox keys to run live. Not yet run against a live sandbox |
| Payment webhooks (signature and freshness checks) | Built and unit-tested. Needs a webhook ID and a public URL to receive events |
| Proof of invoice (signed QR code and public page) | Built and tested |
| Shared projects (split and per-share invoices) | Server built and tested. App screen wired, not yet checked in a browser |
| Payment reminders (approve-then-send) | Server built and tested. App screen not yet added |
| AI replies (classification, drafts, scope gate) | Built. Works with free keys or rules |
| Voice (dictation and voice-note transcription) | Built. Voice notes need a Groq key. Groq's Whisper model availability needs confirming |
| Hindi and English interface | Built and checked in a browser |
| Ledger export (CSV, formula-safe) | Built and unit-tested |
| Sign in with PayPal | Logic built and tested. Routes and button not yet wired in |
| User accounts and per-user data | Not built |
| Hosting on Vercel | Not yet. Needs a hosted database for storage, sessions and rate limits |

Automated tests: see [Tests](#tests). All pass at the time of writing.

---

## How it works

```
Browser (phone or desktop)
   │  landing page, app, legal pages (static files)
   │  bills are read on the device (OCR), never uploaded
   ▼
ClearPaid server (Node.js, no framework, no runtime dependencies)
   │  access token on every API call · rate limits · security headers
   ├──► PayPal sandbox API     invoices, status, reminders, webhooks, sign-in
   ├──► AI providers (free)    Groq → Gemini → OpenRouter → rules (waterfall)
   └──► Local JSON store       invoices, projects, reminders, audit fields
```

Key design rules:
- **Money never passes through ClearPaid.** Clients pay PayPal. Each invoice is paid to its owner.
- **Nothing is sent without approval.** Replies, proofs and reminders wait for a person to press the button.
- **AI is advice, not authority.** Client messages are treated as data. "Paid" is only accepted after PayPal confirms it. Off-topic requests are refused before a model is called.
- **Secrets stay on the server.** Keys are read from environment variables and sent only in request headers.

---

## Quick start

You need **Node.js 18 or newer** (Node 22 is used in development).

```bash
# 1. Get the code
cd collections-assistant

# 2. Create your settings file, then fill it in (see the next section)
cp .env.example .env

# 3. Run the tests (no keys needed)
npm test

# 4. Start the server with your settings
node --env-file=.env server/index.js
```

Then open:
- Landing page: http://localhost:3000/landing/index.html
- App: http://localhost:3000/freelancer/index.html
- Health check: http://localhost:3000/api/health

The app asks for your **access token** (the `API_TOKEN` value from `.env`) the first time it calls the API. The browser keeps it only for that tab.

> On Windows PowerShell, copy the file with `copy .env.example .env`. On Git Bash or macOS/Linux, use `cp`.

---

## Environment settings (.env)

All settings live in a `.env` file in the project folder. The file is ignored by git, so your secrets are not committed. Start from `.env.example`, which lists every setting with comments.

### Settings you need

| Setting | Required | What it is for | How to get it |
|---|---|---|---|
| `API_TOKEN` | **Yes** | Protects the API. Only people with this token can create invoices or use AI | Generate it yourself (see below). At least 32 characters |
| `PROOF_SECRET` | **Yes, for proofs** | Signs invoice proofs so they cannot be changed unnoticed | Generate it yourself. At least 32 characters |
| `PAYPAL_CLIENT_ID` | **Yes, to send invoices** | Identifies your PayPal sandbox app | [PayPal sandbox setup](#setting-up-paypal-sandbox) |
| `PAYPAL_CLIENT_SECRET` | **Yes, to send invoices** | Authenticates your PayPal sandbox app. Keep it private | [PayPal sandbox setup](#setting-up-paypal-sandbox) |
| `PAYPAL_WEBHOOK_ID` | Recommended | Lets ClearPaid receive "invoice paid" events from PayPal | [PayPal sandbox setup](#setting-up-paypal-sandbox), step 5 |
| `GROQ_API_KEYS` | Optional | First free AI provider (also used for voice notes) | [Free AI providers](#setting-up-free-ai-providers) |
| `GEMINI_API_KEYS` | Optional | Second free AI provider | [Free AI providers](#setting-up-free-ai-providers) |
| `OPENROUTER_API_KEYS` | Optional | Third free AI provider | [Free AI providers](#setting-up-free-ai-providers) |

### Settings with defaults

| Setting | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Address used in proof links and messages. Set it to your public HTTPS address when hosting |
| `PORT` | `3000` | The port the server listens on |
| `HOST` | `127.0.0.1` | Listens on this computer only. Change only when hosting |
| `DATA_FILE` | `data/store.json` | Where invoices and reminders are saved in local development |
| `GROQ_MODELS`, `GEMINI_MODELS`, `OPENROUTER_MODELS` | Built-in lists | Comma-separated model names to try, in order |

### Generating the secrets

Run this in a terminal and copy the output into `.env`. Run it once for `API_TOKEN` and once for `PROOF_SECRET`, so the two values differ:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never reuse a secret from an example, a tutorial or another project.

### Example `.env` (fake values, for layout only)

```ini
API_TOKEN=replace-with-a-32-plus-character-random-value
PROOF_SECRET=replace-with-another-32-plus-character-random-value
PAYPAL_CLIENT_ID=your-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
PAYPAL_WEBHOOK_ID=your-sandbox-webhook-id
GROQ_API_KEYS=your-groq-key
GEMINI_API_KEYS=your-gemini-key
OPENROUTER_API_KEYS=your-openrouter-key
PUBLIC_URL=http://localhost:3000
```

---

## Setting up PayPal (sandbox)

ClearPaid uses PayPal's **sandbox**, a test environment with fake money. You need a free PayPal developer account.

1. **Create a developer account.** Go to https://developer.paypal.com and sign in or sign up. Confirm the verification email PayPal sends you.
2. **Open the sandbox accounts.** In the developer dashboard, go to **Sandbox > Accounts**. PayPal creates a **business** account (the seller) and a **personal** account (the buyer) for you. Note the buyer's email and password. Keep them private.
3. **Create an app.** Go to **Apps & Credentials**, make sure **Sandbox** is selected, and click **Create App**. Give it a name such as `ClearPaid local`.
4. **Copy the credentials.** On the app's page, copy the **Client ID** into `PAYPAL_CLIENT_ID` and the **Secret** into `PAYPAL_CLIENT_SECRET`.
5. **Register a webhook (for "invoice paid" events).** On the same app page, open **Webhooks** and add a webhook. For the URL, use `PUBLIC_URL` plus `/api/webhooks/paypal`. PayPal must be able to reach that address, so a local `localhost` address will not receive events. Use a tunnel (such as ngrok or Cloudflare Tunnel) for local testing, or the public address once hosted. Subscribe to these events: `INVOICING.INVOICE.PAID` and `INVOICING.INVOICE.CANCELLED`. Copy the webhook's **ID** into `PAYPAL_WEBHOOK_ID`.
6. **Check it works.** Start the server and open `/api/health`. It should report `"paypalConfigured": true` once both credentials are set.

**Notes**
- PayPal's sandbox is for testing only. Invoices are not real and no money moves.
- PayPal's India rules differ from other countries. Check PayPal's current documentation before any real use.
- The invoice, reminder and webhook endpoints follow PayPal's documented APIs, but they have not yet been run against a live sandbox account. Your first test will confirm them.

---

## Setting up free AI providers

AI is optional. Without keys, ClearPaid uses rule-based logic, which handles common replies. With keys, it uses a language model for better replies.

The app tries providers in this order: **Groq, then Gemini, then OpenRouter, then rules**. If one is rate-limited or fails, the next is tried. A provider that is rate-limited is skipped for a minute.

| Provider | Setting | How to get a key | Notes |
|---|---|---|---|
| Groq | `GROQ_API_KEYS` | Sign up at https://console.groq.com, then create an API key under **API Keys** | Also used for voice-note transcription. Check the current limits on the **Limits** page |
| Google Gemini | `GEMINI_API_KEYS` | Sign in at https://aistudio.google.com and create a key under **Get API key** | Free limits are per Google Cloud project, not per key |
| OpenRouter | `OPENROUTER_API_KEYS` | Sign up at https://openrouter.ai and create a key under **Keys**. Use models ending in `:free` | Free limits are per account |

Rules to know:
- **Several keys from the same account or project do not add free quota.** Use extra keys only for accounts or projects you own. Creating extra accounts to get around limits goes against these providers' terms.
- Free limits change. Check each provider's dashboard before a demo.
- Voice-note transcription uses Groq's hosted Whisper model. Confirm that the model is available on your Groq plan.

---

## Using the app

### Invoices
1. Upload a bill (photo, PDF, email file) or paste its text. Check every field that the app reads, then press **Use these details**.
2. Enter the client's name, email, amount in USD and a short description.
3. Press **Send invoice via PayPal**. PayPal creates the invoice and emails it to the client.
4. Use **Check PayPal status** to see whether it has been paid. Only PayPal can confirm a payment.

### Proof of invoice
Press **Proof** next to a sent invoice. The app shows a QR code and a message. The QR code opens a public page that shows the invoice number, amount, date and status, and never shows contact details. Tick the box to approve, then share on WhatsApp or by email from your own app. Nothing is shared until you tick the box.

### Replies
1. Choose the invoice, then type or dictate the client's message. For voice, use **Speak the message** (uses your browser's speech service) or upload a voice note.
2. Press **Read with AI**. The app shows what the message means, and how confident it is.
3. Press **Suggest a reply**, edit it, and copy it into your own email or chat. Nothing is sent by the app.

### Shared projects
1. Enter the project name, the client and the total in USD.
2. Add each collaborator with their name, their own PayPal email and their share. The shares must add up to 100%.
3. Press **Create project**, then **Invoice each share**. Each person receives their own invoice for their share. You will be asked to confirm first.

### Payment reminders
Invoices are due 30 days after they are created, unless you set another due date. Overdue, unpaid invoices appear as reminders. You approve each one before PayPal sends a reminder. A reminder is sent at most once a week per invoice, and only a few are allowed per day. You can also snooze a reminder for a week without sending it.

### Money
1. Enter the invoice amount, today's rupee rate, PayPal's fees, the conversion markup and the number of days until payment.
2. See the amount you would receive, the fees, the cost of waiting, and a comparison of routes.
3. Choose a month and download the **ledger** (CSV) for your accountant. Rates are the ones you entered, not fetched from history.

### Language
Use the **हिन्दी / English** button at the top of the app to switch the interface language.

---

## API reference

All API routes need the header `Authorization: Bearer <API_TOKEN>`, except `GET /api/health` and the PayPal webhook. Requests and responses are JSON.

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Status, and whether PayPal and AI providers are configured. Public |
| `POST /api/invoices` | Create an invoice in PayPal. Body: `invoiceNumber`, `customerEmail`, `customerName`, `amount`, `currency`, optional `dueDate` (YYYY-MM-DD) |
| `POST /api/invoices/:id/send` | Send an invoice to the client through PayPal |
| `GET /api/invoices/:id` | Read the PayPal status of an invoice |
| `POST /api/invoices/:id/proof` | Create a signed proof. Returns a QR code value, a public verification link, and share text |
| `GET /proof/:token` | Public proof page. Shows only the invoice number, amount, date and status |
| `POST /api/projects` | Create a shared project. Shares must total 100% |
| `GET /api/projects/:id` | Read a project's shares and payment status |
| `POST /api/projects/:id/invoices` | Invoice every share that has not been invoiced yet |
| `GET /api/reminders` | List overdue invoices that can be reminded |
| `POST /api/reminders/:id/approve` | Send one PayPal reminder (approval required) |
| `POST /api/reminders/:id/snooze` | Wait a week before reminding this invoice again. Sends nothing |
| `POST /api/webhooks/paypal` | Receives PayPal events. Checked against PayPal's signature and must be recent. Public |
| `POST /api/ai/classify` | Classify a client's message |
| `POST /api/ai/draft` | Draft a reply for a message type |
| `POST /api/ai/transcribe` | Turn a voice note into text (needs a Groq key) |
| `POST /api/assistant` | Ask a question about invoices, payments or clients. Off-topic questions are refused |

Errors return a short message. Server errors return a generic message, and the detail stays in the server log.

---

## Security model

ClearPaid handles invoices and money, so the defaults are strict. Here is what the build enforces today.

- **Access token on every API call.** Requests need a bearer token. Tokens are compared in constant time (`crypto.timingSafeEqual`).
- **Secrets stay on the server.** PayPal and AI keys live in environment variables and are sent only in request headers, never in URLs or browser code.
- **Strict browser policy.** A Content Security Policy limits where scripts and styles can come from. Pages cannot be framed (`frame-ancestors 'none'`). `nosniff`, a strict referrer policy and a permissions policy are set on every response.
- **No caching of API responses** (`Cache-Control: no-store`).
- **Rate limits.** Every caller is limited per minute. AI calls also have a per-minute and a daily cap.
- **Input checks.** Request bodies are size-limited. Invoice fields, dates, emails and amounts are validated before use. Invoice numbers are restricted to safe characters.
- **No double sends.** The same invoice number cannot be created twice, and an invoice cannot be sent twice.
- **Signed proofs.** Each proof is signed with HMAC-SHA256 using `PROOF_SECRET`. Any change to the details breaks the signature. The proof page is public, but it is protected by a random 24-byte token and shows no contact details.
- **Verified webhooks.** Every PayPal webhook is checked with PayPal's verification API, and events older or newer than five minutes are refused. Repeated events are ignored.
- **AI scope gate.** Off-topic and rule-changing questions are refused before any model is called. Model answers are checked for length and role before they are shown.
- **Client text is data.** Messages from clients are never treated as instructions. Instruction-like text is flagged.
- **Local-first document reading.** Bill photos and PDFs are read in the browser and are not uploaded.
- **Safe spreadsheet export.** Cells that could run formulas in a spreadsheet are escaped.
- **Localhost by default.** The server listens on `127.0.0.1` unless you set `HOST`.

**Not finished yet:** user accounts and sign-in, HTTPS on a public domain, removing the remaining inline scripts from the browser policy, an independent security review and penetration test, and a written data-retention schedule. See `legal/security.html` for the full list.

---

## Project structure

```
collections-assistant/
├── .env.example            settings template (copy to .env, never commit .env)
├── package.json            scripts: start and test. No runtime dependencies
├── README.md               this file
├── landing/                product landing page and images
│   ├── index.html
│   └── assets/             logo, illustrations, photos
├── freelancer/             main app (invoices, replies, money, projects, reminders)
│   ├── index.html          the app: layout, styles and browser logic
│   ├── calc.js             money maths (fees, conversion, cost of waiting)
│   └── lib/
│       ├── parse-invoice.js   reads amounts, numbers, dates and clients from text
│       ├── ledger.js          monthly CSV with formula-safe cells
│       └── i18n.js            English and Hindi labels
├── kyc/                    secondary prototype: ID capture checks and format checks
│   └── lib/                quality, checks, extract
├── legal/                  privacy, terms, disclaimer, security and data pages
├── server/
│   ├── index.js            HTTP server, routes, static files, security headers
│   ├── paypal.js           PayPal sandbox client (invoices, status, reminders)
│   ├── webhooks.js         PayPal webhook verification and event handling
│   ├── reminders.js        overdue finder, approval, weekly and daily limits
│   ├── project.js          shared project splits (cent-exact)
│   ├── proof.js            signed proofs and the public proof page
│   ├── ai.js               classification, drafts, assistant, transcription
│   ├── llm.js              free provider waterfall, keys, models, cooldowns
│   ├── scope.js            on-topic gate and answer checks
│   ├── security.js         token check, headers, rate limiting, safe errors
│   ├── auth.js             sign in with PayPal logic (routes not yet wired)
│   └── store.js            local JSON store (to be replaced by a hosted database)
├── tests/                  automated tests, run with node --test
└── data/                   local store (created automatically, git-ignored)
```

Internal working notes are kept in the `process/` folder, which is git-ignored.

---

## Tests

```bash
npm test
```

The suite uses Node's built-in test runner and needs no keys or network access. It covers:
- the server routes, including access control, rate limits, security headers and the localhost default,
- the PayPal client, using a fake fetch,
- webhook verification, replay protection and duplicate handling,
- reminders, including weekly and daily limits and PayPal failures,
- shared project splits, including exact cent totals,
- proofs, including tampering, escaping and the public page,
- the AI waterfall, cooldowns, scope gate and key handling,
- the invoice reader, ledger export, money maths, translations and KYC checks,
- sign in with PayPal logic, including one-time state values and token handling.

---

## Deployment

ClearPaid is written as a single Node server with static pages. It is not yet ready for serverless hosting such as Vercel, for two reasons:

1. **Storage.** Invoices and reminders are saved to a local JSON file. Serverless functions do not keep local files between requests.
2. **Sessions and rate limits.** These live in the server's memory, so they reset constantly on serverless hosting.

The planned fix is a hosted key-value or SQL database for storage, sessions and rate limits, such as Upstash Redis or Neon (see the Roadmap).

Once that is in place, deploying means:
1. Set every setting from the [environment table](#settings-you-need) in the hosting dashboard. Never commit `.env`.
2. Set `PUBLIC_URL` to your HTTPS address.
3. Register the PayPal webhook at `PUBLIC_URL/api/webhooks/paypal`, and the sign-in return address at `PUBLIC_URL/auth/paypal/callback` once sign-in is wired in.
4. Check `/api/health`, then run one full test invoice in the sandbox.

---

## Troubleshooting

| Problem | What to check |
|---|---|
| The app asks for an access token | Enter the `API_TOKEN` value from `.env` (not the variable name). Make sure the value is at least 32 characters |
| "Set API_TOKEN (at least 32 characters) in .env" | The server did not load `.env`. Start it with `node --env-file=.env server/index.js` |
| "PayPal is not configured" | `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` is empty, or the server was not restarted after editing `.env` |
| PayPal sign-in failed (401) | Check the client ID and secret belong to the same sandbox app. Check the sandbox setting |
| Webhook events are not arriving | PayPal cannot reach `localhost`. Use a tunnel for testing, and check `PAYPAL_WEBHOOK_ID` |
| "Webhook signature not verified" | The webhook ID does not match the one PayPal shows, or the event is more than five minutes old |
| AI replies use rules, not a model | No AI key is set, or every provider is rate-limited. Check `/api/health` for `aiProviders` |
| "AI request limit reached" | You hit the per-minute or daily cap. Wait, or raise the limit in `server/index.js` for testing |
| Voice-note transcription fails | It needs `GROQ_API_KEYS`, and Groq's Whisper model must be available on your plan |
| A bill's amount is not found | Paste the text instead, or type the amount. Scans need clear, flat photos |
| "This PDF has no text layer" | The PDF is a scan. Upload a photo of it instead |
| "Reminder not sent: daily limit reached" | The cap is five reminders a day. It resets the next day |
| Layout looks wrong on a phone | Hard-refresh the page. Check the browser's device mode |

---

## Roadmap

**Next**
- Sign in with PayPal (logic is built and tested; routes and button to be wired)
- Hosted database for storage, sessions and rate limits, then deployment to Vercel
- Reminders screen in the app
- Browser checks for the proof, project and dictation screens
- Live sandbox test of invoices, webhooks and reminders

**Later**
- User accounts with separate data for each person
- Routing each shared-project invoice to the collaborator's own PayPal account
- Audit log of every approval, send and reminder
- Accounting export to Zoho Books or similar
- More Indian languages, following the same dictionary structure
- Offline-first installable app

Ideas we considered and set aside:
- Letting an email reply trigger a payment. Email can be spoofed, so approval must happen inside PayPal's own checkout.
- Storing passwords or fingerprints. Those stay with PayPal and the device.
- Holding money between freelancers. That needs a payment licence in India, so each freelancer is paid directly.

---

## Licence and credits

- **Licence:** to be chosen before the public submission. The repository must show a licence file in its About section.
- **Third-party libraries:** the app loads Tesseract.js (text recognition), PDF.js (PDF text), and qrcode-generator (QR codes) from public CDNs. Each keeps its own licence.
- **Illustrations:** original artwork made for ClearPaid.
- **Photos:** licensed photographs. Photo credits are added to the landing-page footer before publication.
- **PayPal** is a trademark of its owner. ClearPaid is an independent prototype and is not endorsed by PayPal.

Built for the PayPal "Build What's Next" hackathon.
