// ClearPaid app logic, shared by the mobile app and the desktop website.

  const F = window.FreelancerCalc;
  const I18N = window.FreelancerI18n;
  const LEDGER = window.FreelancerLedger;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = n => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");

  // ---- Language ----
  let lang = "en";
  try { lang = localStorage.getItem("fp-lang") === "hi" ? "hi" : "en"; } catch { lang = "en"; }
  const t = key => (I18N.DICT[lang] && I18N.DICT[lang][key]) || I18N.DICT.en[key] || key;

  function setLang(next) {
    lang = next;
    try { localStorage.setItem("fp-lang", lang); } catch { /* keep in memory */ }
    I18N.applyLang(document, lang);
    $("langBtn").textContent = lang === "hi" ? "English" : "हिन्दी";
    renderInvoices();
    renderConfigPills();
    renderMoney();
  }
  $("langBtn").addEventListener("click", () => setLang(lang === "hi" ? "en" : "hi"));

  // ---- Storage: a convenience only. PayPal status is always fetched live. ----
  const STORE_KEY = "freelancer-invoices-v2";
  let invoices = [];
  let config = { paypalConfigured: false, aiProviders: [] };
  let lastClassification = null;
  let voiceBase64 = null;
  let voiceMime = null;
  let voiceName = null;

  function loadInvoices() {
    try { invoices = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { invoices = []; }
  }
  function saveInvoices() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(invoices)); } catch { /* private mode */ }
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // The access token is kept for this browser tab only (sessionStorage) and sent as a Bearer token over HTTPS.
  function accessToken() {
    try { return sessionStorage.getItem("cp-token") || ""; } catch { return ""; }
  }
  function showTokenBox() {
    $("tokenBox").classList.remove("hidden");
  }
  async function api(path, body) {
    const headers = body === undefined ? {} : { "Content-Type": "application/json" };
    const token = accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/health") showTokenBox();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function saveToken() {
    const value = $("tokenInput").value.trim();
    if (value.length < 32) { toast("The access token is at least 32 characters."); return; }
    try { sessionStorage.setItem("cp-token", value); } catch { /* keep in memory only */ }
    $("tokenInput").value = "";
    $("tokenBox").classList.add("hidden");
    loadConfig().then(loadProject);
  }

  // ---- Status ----
  function renderConfigPills() {
    $("pillPaypal").textContent = config.paypalConfigured ? t("pill.paypalOn") : t("pill.paypalOff");
    const providers = config.aiProviders || [];
    $("pillAi").textContent = providers.length
      ? `AI: ${providers[0]}${providers.length > 1 ? ` + ${providers.length - 1} fallback` : ""}`
      : t("pill.aiOff");
    $("banner").classList.toggle("hidden", config.paypalConfigured);
    $("sendInvoice").disabled = !config.paypalConfigured;
    $("sendHint").textContent = config.paypalConfigured
      ? "Creates the invoice in PayPal's sandbox and PayPal emails it to the client."
      : "Connect PayPal sandbox keys to enable sending.";
  }

  async function loadConfig() {
    try { config = await api("/api/health"); } catch { config = { paypalConfigured: false, aiProviders: [] }; }
    renderConfigPills();
    renderFeatures(config.paypalFeatures);
    loadActivity();
    const me = await fetch("/api/me").then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (me && me.user) {
      $("accountName").textContent = me.user.provider === "demo"
        ? "Demo mode. Sandbox data only. Sign in with PayPal to send invoices."
        : `Signed in as ${me.user.name || me.user.email}`;
      $("accountBar").classList.remove("hidden");
      $("tokenBox").classList.add("hidden");
      // Demo visitors get a few sample invoices so every screen shows how it works. They never reach PayPal.
      if (me.user.provider === "demo") seedDemoInvoices();
      else if (invoices.some(i => i.sample)) { invoices = invoices.filter(i => !i.sample); saveInvoices(); renderInvoices(); }
    } else if (config.authRequired && !accessToken()) {
      showTokenBox();
    }
  }

  // Sample invoices for the demo, stored on this device only. They have no PayPal id, so no PayPal call is made for them.
  function seedDemoInvoices() {
    if (invoices.some(i => i.sample)) return;
    const today = new Date();
    const day = n => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
    const samples = [
      { number: "DEMO-001", clientName: "Sample client, Berlin", description: "Logo design (sample)", amountUsd: 800, dueDate: day(10), rate: 83, sample: true },
      { number: "DEMO-002", clientName: "Sample client, Toronto", description: "Website copy (sample)", amountUsd: 350, dueDate: day(-4), rate: 83, sample: true },
      { number: "DEMO-003", clientName: "Sample client, Dubai", description: "Brand book (sample), paid", amountUsd: 1200, dueDate: day(-20), rate: 82, paypalStatus: "PAID", paidAt: day(-18), sample: true }
    ];
    invoices = [...samples, ...invoices];
    saveInvoices();
    renderInvoices();
    renderMoney();
  }

  // ---- Tabs ----
  // ---- Navigation. Each feature is its own screen: a page on the desktop website, a screen in the mobile app. ----
  const VIEWS = ["home", "invoices", "scan", "projects", "replies", "money", "reminders", "activity"];
  const SHELL = document.body.dataset.shell === "mobile" ? "mobile" : "desktop";
  function currentView() {
    if (SHELL === "desktop") return VIEWS.includes(document.body.dataset.view) ? document.body.dataset.view : "home";
    const h = location.hash.replace("#", "");
    return VIEWS.includes(h) ? h : "home";
  }
  function viewHref(name) {
    if (SHELL === "mobile") return "#" + name;
    return name === "home" ? "index.html" : name + ".html";
  }
  function goTo(name) {
    if (SHELL === "mobile") { location.hash = name; return; }
    location.href = viewHref(name);
  }
  function showView(name) {
    const view = VIEWS.includes(name) ? name : "home";
    document.querySelectorAll("[data-view-panel]").forEach(el => el.classList.toggle("hidden", el.dataset.viewPanel !== view));
    document.querySelectorAll("[data-nav]").forEach(a => {
      const on = a.dataset.nav === view;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (SHELL === "mobile") window.scrollTo({ top: 0 });
    if (view === "home") renderHome();
    if (view === "money") renderMoney();
    if (view === "reminders") loadReminders();
    if (view === "activity") loadActivity();
  }
  document.querySelectorAll("[data-nav], [data-nav-link]").forEach(a => a.setAttribute("href", viewHref(a.dataset.nav || a.dataset.navLink)));
  window.addEventListener("hashchange", () => showView(currentView()));
  if ($("moreBtn")) {
    const sheet = $("moreSheet");
    $("moreBtn").addEventListener("click", () => sheet.classList.remove("hidden"));
    $("moreClose").addEventListener("click", () => sheet.classList.add("hidden"));
    sheet.addEventListener("click", e => { if (e.target === sheet || e.target.closest("[data-nav]")) sheet.classList.add("hidden"); });
  }

  // ---- Invoices ----
  function nextInvoiceNumber() {
    return `FP-${new Date().getFullYear()}-${String(invoices.length + 1).padStart(3, "0")}`;
  }

  function payLinkOf(inv) {
    const link = (inv.links || []).find(l => /payer/i.test(l.rel || ""));
    return link ? link.href : null;
  }

  function renderInvoices() {
    const sel = $("replyInvoice");
    sel.innerHTML = invoices.length
      ? invoices.map(i => `<option value="${esc(i.number)}">${esc(i.number)} · ${esc(i.clientName)} · ${usd(i.amountUsd)}</option>`).join("")
      : `<option value="">${t("inv.none")}</option>`;

    $("invoiceList").innerHTML = invoices.length ? invoices.map(i => {
      const tags = [];
      if (i.emailedAt) tags.push(`<span class="tag ok">${t("inv.emailed")}</span>`);
      if (i.paypalStatus === "PAID") tags.push(`<span class="tag ok">${t("inv.paid")}</span>`);
      else if (i.paypalStatus) tags.push(`<span class="tag wait">${esc(i.paypalStatus)}</span>`);
      const pay = payLinkOf(i);
      const split = invoiceSplitLine(i.amountUsd);
      return `
      <div class="inv">
        <div class="inv-head">
          <div>
            <div class="inv-title">${esc(i.clientName)}</div>
            <div class="muted" style="margin:0;">${esc(i.number)} · ${esc(i.description || "Service")}</div>
          </div>
          <div class="amt">${usd(i.amountUsd)}</div>
        </div>
        ${tags.join("")}
        ${split}
        ${i.paypalId ? `
          <div class="row" style="margin-top:10px;">
            <button class="btn ghost" data-check="${esc(i.paypalId)}">${t("inv.check")}</button>
            <button class="btn ghost" data-proof="${esc(i.number)}">Proof</button>
            ${i.paypalStatus === "PAID" ? "" : `<button class="btn ghost" data-paylink="${esc(i.paypalId)}">Pay link</button>`}
            ${pay ? `<a class="btn" style="text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;" href="${esc(pay)}" target="_blank" rel="noopener">${t("inv.payLink")}</a>` : ""}
          </div>` : `<p class="muted" style="margin:8px 0 0;">${t("inv.local")}</p>`}
      </div>`;
    }).join("") : `<div class="empty">${t("inv.none")}</div>`;
  }

  $("sendInvoice").addEventListener("click", async () => {
    const clientName = $("clientName").value.trim();
    const clientEmail = $("clientEmail").value.trim();
    const amountUsd = Number($("amountUsd").value);
    const description = $("description").value.trim();
    if (!clientName || !clientEmail || !(amountUsd > 0)) {
      toast("Add the client's name, email and an amount.");
      return;
    }
    const number = nextInvoiceNumber();
    $("sendInvoice").disabled = true;
    try {
      const created = await api("/api/invoices", {
        invoiceNumber: number, customerEmail: clientEmail, customerName: clientName,
        amount: amountUsd, currency: "USD", note: description
      });
      const sent = await api(`/api/invoices/${encodeURIComponent(created.id)}/send`, {});
      invoices.unshift({
        number, clientName, clientEmail, amountUsd, description,
        paypalId: created.id, paypalStatus: "SENT", links: created.links || [],
        emailedAt: new Date().toISOString(), emailedTo: sent.emailedTo || clientEmail
      });
      saveInvoices();
      renderInvoices();
      toast(t("toast.emailed"));
      loadActivity();
      $("description").value = "";
    } catch (err) {
      toast(err.message);
    } finally {
      $("sendInvoice").disabled = !config.paypalConfigured;
    }
  });

  async function checkStatus(id, btn) {
    if (btn) btn.disabled = true;
    try {
      const inv = await api(`/api/invoices/${encodeURIComponent(id)}`);
      const row = invoices.find(i => i.paypalId === id);
      if (row) {
        row.paypalStatus = inv.status || "UNKNOWN";
        if (row.paypalStatus === "PAID" && !row.paidAt) row.paidAt = new Date().toISOString();
        row.rate = row.rate || Number($("mRate").value) || null;
      }
      saveInvoices();
      renderInvoices();
      renderMoney();
      toast(inv.status === "PAID" ? "PayPal confirms: paid" : `PayPal status: ${inv.status || "unknown"}`);
    } catch (err) {
      toast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener("click", e => {
    const check = e.target.closest("[data-check]");
    if (check) checkStatus(check.dataset.check, check);
    const payLink = e.target.closest("[data-paylink]");
    if (payLink) createPayLink(payLink.dataset.paylink, payLink);
  });

  // ---- Scan or upload a bill (reads on this device) ----
  const MAX_BYTES = 10 * 1024 * 1024;
  let docResult = null;

  function docPanel(prefix) {
    return `
      <div class="card">
        <h2 data-i18n="doc.title">Scan or upload a bill</h2>
        <p class="muted" data-i18n="doc.sub">A photo of a bill, a PDF, an email file, or pasted text. Read on this device. You check every field before using it.</p>
        <div class="drop" data-doc-drop="${prefix}" tabindex="0" role="button" aria-label="Choose a file, or drop one here">
          <div class="drop-icon" aria-hidden="true">⬆</div>
          <div class="drop-text">
            <strong data-doc-name="${prefix}" data-i18n="doc.drop">Drop a bill here, or tap to choose</strong>
            <span class="muted" data-i18n="doc.types">Photo, PDF, EML or TXT · up to 10 MB</span>
          </div>
        </div>
        <input type="file" class="hidden" accept="image/*,.pdf,.txt,.eml,.html,.htm,.md,.csv" data-doc-file="${prefix}">
        <div class="or"><span data-i18n="doc.or">or paste the text</span></div>
        <textarea data-doc-text="${prefix}" data-i18n-placeholder="doc.paste" placeholder="Paste the email or bill text here" rows="4"></textarea>
        <button class="btn" data-doc-read="${prefix}" data-i18n="doc.read">Read document</button>
        <div data-doc-out="${prefix}" style="margin-top:12px;"></div>
      </div>`;
  }

  async function ocrImage(file) {
    if (!window.Tesseract) throw new Error("Text recognition did not load. Check the connection, or paste the text instead.");
    const { data } = await Tesseract.recognize(file, "eng");
    return data.text;
  }

  async function pdfText(file) {
    if (!window.pdfjsLib) throw new Error("The PDF reader did not load. Check the connection, or paste the text instead.");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = "";
    for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      out += content.items.map(item => item.str).join(" ") + "\n";
    }
    if (!out.trim()) throw new Error("This PDF has no text layer, so it is a scan. Upload a photo of it instead.");
    return out;
  }

  async function readFile(file) {
    if (file.size > MAX_BYTES) throw new Error("That file is larger than 10 MB.");
    if (file.type.startsWith("image/")) return ocrImage(file);
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return pdfText(file);
    return file.text();
  }

  function fieldRow(label, item, text) {
    const shown = item ? esc(text ?? item.value) : `<span class="muted">not found</span>`;
    return `<div class="kv"><span class="k">${label}</span><span>${shown}</span></div>`;
  }

  function renderDocResult(r, prefix) {
    const f = r.fields;
    const amountText = f.amount ? `${f.amount.currency || "currency?"} ${Number(f.amount.value).toLocaleString("en-US")}` : null;
    const canUse = Boolean(f.amount) && (!f.amount.currency || f.amount.currency === "USD");
    const warnings = r.warnings.map(w => `<div class="banner" style="margin-top:8px;">${esc(w)}</div>`).join("");
    return `
      <div class="result">
        <div class="muted" style="margin:0 0 6px;">Found ${r.found} of ${r.total} fields. Check each one before you use it.</div>
        ${fieldRow("Amount", f.amount, amountText)}
        ${fieldRow("Invoice number", f.invoiceNumber)}
        ${fieldRow("Due date", f.dueDate)}
        ${fieldRow("Client", f.clientName)}
        ${fieldRow("Client email", f.clientEmail)}
        ${warnings}
        <div class="row" style="margin-top:12px;">
          <button class="btn" data-doc-use="${prefix}" ${canUse ? "" : "disabled"} data-i18n="doc.use">Use these details</button>
        </div>
      </div>`;
  }

  async function readDocument(prefix) {
    const out = document.querySelector(`[data-doc-out="${prefix}"]`);
    const file = document.querySelector(`[data-doc-file="${prefix}"]`).files[0];
    const pasted = document.querySelector(`[data-doc-text="${prefix}"]`).value.trim();
    out.innerHTML = `<p class="muted">Reading…</p>`;
    try {
      const text = file ? await readFile(file) : pasted;
      if (!text || !text.trim()) throw new Error("Nothing to read. Upload a file or paste the text.");
      docResult = InvoiceParser.parseInvoice(text);
      out.innerHTML = renderDocResult(docResult, prefix);
      I18N.applyLang(out, lang);
    } catch (err) {
      docResult = null;
      out.innerHTML = `<div class="banner">${esc(err.message)}</div>`;
    }
  }

  function useDocResult() {
    if (!docResult) return;
    const f = docResult.fields;
    if (f.amount) {
      $("mAmount").value = f.amount.value;
      $("amountUsd").value = f.amount.value;
    }
    if (f.clientName) $("clientName").value = f.clientName.value;
    if (f.clientEmail) $("clientEmail").value = f.clientEmail.value;
    renderMoney();
    toast("Details filled in. Check them before you continue.");
    try { sessionStorage.setItem("cp-prefill", JSON.stringify({ amount: f.amount ? f.amount.value : null, clientName: f.clientName ? f.clientName.value : null, clientEmail: f.clientEmail ? f.clientEmail.value : null })); } catch { /* memory only */ }
    goTo("invoices");
  }

  function showChosenFile(prefix, file) {
    const zone = document.querySelector(`[data-doc-drop="${prefix}"]`);
    const name = document.querySelector(`[data-doc-name="${prefix}"]`);
    name.textContent = file ? file.name : t("doc.drop");
    zone.classList.toggle("has-file", Boolean(file));
  }

  // ---- Voice note upload (sent to speech-to-text on the server) ----
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsDataURL(file);
    });
  }

  $("voiceDrop").addEventListener("click", () => $("voiceFile").click());
  $("voiceDrop").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("voiceFile").click(); } });
  $("voiceFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { toast("Voice note is larger than 6 MB."); return; }
    voiceName = file.name;
    voiceMime = file.type || "audio/webm";
    voiceBase64 = await readAsBase64(file);
    $("voiceName").textContent = file.name;
    $("transcribeBtn").disabled = false;
  });

  $("transcribeBtn").addEventListener("click", async () => {
    if (!voiceBase64) return;
    $("transcribeBtn").disabled = true;
    try {
      const r = await api("/api/ai/transcribe", { audioBase64: voiceBase64, mime: voiceMime, filename: voiceName });
      $("replyText").value = r.text;
      toast("Voice note turned into text. Check it, then read with AI.");
    } catch (err) {
      toast(err.message);
    } finally {
      $("transcribeBtn").disabled = false;
    }
  });

  // ---- Replies with AI ----
  const LABEL_TEXT = {
    paid: "Says paid", will_pay: "Promises to pay", asks_discount: "Asks for a discount",
    dispute: "Disputes the work", not_received: "Did not get the invoice", other: "Other"
  };
  const TAG_FOR = { paid: "ok", will_pay: "ok", asks_discount: "wait", dispute: "bad", not_received: "wait", other: "wait" };

  $("classifyBtn").addEventListener("click", async () => {
    const text = $("replyText").value.trim();
    if (!text) { toast("Paste the client's message first."); return; }
    $("classifyBtn").disabled = true;
    try {
      const r = await api("/api/ai/classify", { text });
      lastClassification = r;
      const inv = invoices.find(i => i.number === $("replyInvoice").value);
      const verify = r.label === "paid" && inv && inv.paypalId
        ? `<div class="muted" style="margin-top:8px;">Before you believe this, check PayPal.</div><div class="row" style="margin-top:8px;"><button class="btn ghost" data-check="${esc(inv.paypalId)}">${t("inv.check")}</button></div>`
        : "";
      $("classifyResult").innerHTML = `
        <div class="result">
          <div class="label">${esc(LABEL_TEXT[r.label] || r.label)}</div>
          <div><span class="tag ${TAG_FOR[r.label] || "wait"}">${Math.round(r.confidence * 100)}% confident</span>
               <span class="tag ai">${r.source === "rules" ? "Rule-based" : "AI: " + esc(r.source)}</span>
               ${r.flagged ? `<span class="tag bad">Instructions ignored</span>` : ""}</div>
          <p style="margin:8px 0 0;">${esc(r.reason)}</p>
          ${verify}
          <div class="row" style="margin-top:12px;"><button class="btn ai" id="draftBtn">${t("reply.suggest")}</button></div>
        </div>`;
    } catch (err) {
      toast(err.message);
    } finally {
      $("classifyBtn").disabled = false;
    }
  });

  $("classifyResult").addEventListener("click", e => {
    if (e.target.id === "draftBtn") draftReply();
  });

  async function draftReply() {
    if (!lastClassification) return;
    const inv = invoices.find(i => i.number === $("replyInvoice").value) || {};
    $("draftCard").classList.remove("hidden");
    $("draftText").value = "…";
    try {
      const r = await api("/api/ai/draft", {
        label: lastClassification.label,
        invoiceNumber: inv.number || "your invoice",
        amountUsd: inv.amountUsd,
        clientName: inv.clientName,
        paymentLink: payLinkOf(inv)
      });
      $("draftText").value = r.text;
      $("draftSource").textContent = r.source === "template"
        ? "Template reply (no AI key or the AI was unavailable). Edit as you like."
        : `Written by AI (${r.source}). Check it before sending.`;
    } catch (err) {
      $("draftText").value = "";
      toast(err.message);
    }
  }
  $("draftAgain").addEventListener("click", draftReply);
  $("copyDraft").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("draftText").value);
      toast(t("toast.copied"));
    } catch {
      $("draftText").select();
      toast("Select and copy the text");
    }
  });

  // Per-invoice split: client pays, PayPal fee, what the freelancer keeps. Uses the Money tab's rates (estimates).
  function invoiceSplitLine(amountUsd) {
    const amt = Number(amountUsd);
    if (!(amt > 0)) return "";
    const s = F.invoiceSplit(amt, moneyOpts());
    return `<div class="muted split-line" style="margin:8px 0 0;">
      Client pays ${usd(s.clientPaysUsd)} · PayPal fee ${usd(s.paypalFeeUsd)} · You keep about ${inr(s.youKeepInr)} <span class="muted">(estimate)</span>
    </div>`;
  }

  // ---- Money ----
  function moneyOpts() {
    return {
      midMarketRate: Number($("mRate").value) || 83,
      receivingFeePct: Number($("mRecv").value) || 0,
      conversionMarkupPct: Number($("mMarkup").value) || 0,
      withdrawalFee: 0,
      opportunityRatePct: 12
    };
  }

  // One-click pay link: a PayPal order the client approves directly, no invoice email needed.
  async function createPayLink(storeId, btn) {
    btn.disabled = true;
    try {
      const { approveUrl } = await api(`/api/invoices/${encodeURIComponent(storeId)}/payment-link`, {});
      if (!approveUrl) { toast("PayPal did not return a pay link. Check the sandbox setup."); return; }
      try { await navigator.clipboard.writeText(approveUrl); toast("Pay link copied. Send it to your client."); }
      catch { toast(`Pay link: ${approveUrl}`); }
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // Real fees from PayPal's own transaction records, for this freelancer's invoices only.
  async function loadRealFees() {
    const box = $("mReal");
    box.innerHTML = `<div class="muted">Loading…</div>`;
    try {
      const data = await api("/api/paypal/fees?days=30");
      if (data.demo) { box.innerHTML = `<p class="muted">${esc(data.note)}</p>`; return; }
      const s = data.summary;
      if (!s.count) { box.innerHTML = `<p class="muted">No completed payments in the last 30 days yet.</p>`; return; }
      box.innerHTML = `
        <div class="kv"><span class="k">Payments</span><span>${s.count}</span></div>
        <div class="kv"><span class="k">Received gross</span><span>${usd(s.grossTotal)}</span></div>
        <div class="kv"><span class="k">PayPal fees charged</span><span>${usd(s.feeTotal)}</span></div>
        <div class="kv"><span class="k">Real fee rate</span><span class="loss">${s.effectivePct}%</span></div>`;
    } catch (err) {
      box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
  }
  $("mRealBtn").addEventListener("click", loadRealFees);

  function renderMoney() {
    const opts = moneyOpts();
    const amount = Number($("mAmount").value) || 0;
    const days = Number($("mDays").value) || 0;
    const r = F.netReceived(amount, opts);
    $("mNet").textContent = inr(r.netInr);
    $("mBreakdown").innerHTML = `
      <div class="kv"><span class="k">Invoice</span><span>${usd(amount)} (${inr(r.idealInr)} at the live rate)</span></div>
      <div class="kv"><span class="k">PayPal receiving fee</span><span>${usd(r.receivingFeeUsd)}</span></div>
      <div class="kv"><span class="k">Conversion markup</span><span>${inr(r.conversionLossInr)}</span></div>
      <div class="kv"><span class="k">Total lost to fees</span><span class="loss">${inr(r.totalLossInr)} (${r.effectivePct}%)</span></div>`;
    $("mLate").textContent = `${inr(F.lateCostInr(amount, days, opts))} (${days} days)`;

    const routes = [
      { name: "PayPal (your settings)", receivingFeePct: opts.receivingFeePct, conversionMarkupPct: opts.conversionMarkupPct },
      { name: "PayPal, low end of estimate", receivingFeePct: 3, conversionMarkupPct: 3 },
      { name: "Bank wire (illustrative)", receivingFeePct: 0, conversionMarkupPct: 1, withdrawalFee: 15 },
      { name: "Transfer service (illustrative)", receivingFeePct: 0.6, conversionMarkupPct: 0.5 }
    ].map(x => ({ ...x, midMarketRate: opts.midMarketRate, opportunityRatePct: 12 }));
    const ranked = F.compare(amount, routes);
    $("mCompare").innerHTML = ranked.map((x, i) => `
      <div class="kv"><span class="k">${esc(x.name)}</span><span style="${i === 0 ? "color:var(--ok);font-weight:700" : ""}">${inr(x.netInr)}</span></div>`).join("");
  }
  ["mAmount", "mRate", "mRecv", "mMarkup", "mDays"].forEach(id => $(id).addEventListener("input", renderMoney));

  // ---- Ledger download ----
  function ledgerRows() {
    const opts = moneyOpts();
    return invoices
      .filter(i => i.paypalStatus === "PAID" || i.paidAt)
      .map(i => ({
        paidAt: i.paidAt || null,
        number: i.number,
        clientName: i.clientName,
        amountUsd: i.amountUsd,
        rate: i.rate || opts.midMarketRate,
        receivingFeePct: opts.receivingFeePct,
        notes: ""
      }));
  }

  function renderLedgerNote(ledger) {
    const parts = [];
    parts.push(`${ledger.rows.length} invoice(s) included.`);
    if (ledger.missing.length) parts.push(`${ledger.missing.length} not included: ${ledger.missing.map(m => m.number + " (" + m.problem + ")").join(", ")}.`);
    parts.push("Rates are the calculator rate on the day each invoice was checked. Edit the rate per row in the CSV if the rate on receipt differed.");
    $("ledgerNote").textContent = parts.join(" ");
  }

  $("ledgerBtn").addEventListener("click", () => {
    const month = $("ledgerMonth").value || new Date().toISOString().slice(0, 7);
    const ledger = LEDGER.buildLedger(ledgerRows(), { month });
    renderLedgerNote(ledger);
    if (!ledger.rows.length) { toast("No paid invoices for that month yet."); return; }
    const blob = new Blob([LEDGER.toCsv(ledger)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---- Start ----
  $("docInv").innerHTML = docPanel("invoices");
  document.addEventListener("click", e => {
    const read = e.target.closest("[data-doc-read]");
    if (read) readDocument(read.dataset.docRead);
    if (e.target.closest("[data-doc-use]")) useDocResult();
    const drop = e.target.closest("[data-doc-drop]");
    if (drop) document.querySelector(`[data-doc-file="${drop.dataset.docDrop}"]`).click();
  });
  document.addEventListener("keydown", e => {
    const drop = e.target.closest && e.target.closest("[data-doc-drop]");
    if (drop && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); drop.click(); }
  });
  document.addEventListener("change", e => {
    if (e.target.matches && e.target.matches("[data-doc-file]")) showChosenFile(e.target.dataset.docFile, e.target.files[0]);
  });
  document.addEventListener("dragover", e => {
    const zone = e.target.closest && e.target.closest("[data-doc-drop]");
    if (zone) { e.preventDefault(); zone.classList.add("over"); }
  });
  document.addEventListener("dragleave", e => {
    const zone = e.target.closest && e.target.closest("[data-doc-drop]");
    if (zone) zone.classList.remove("over");
  });
  document.addEventListener("drop", e => {
    const zone = e.target.closest && e.target.closest("[data-doc-drop]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("over");
    const input = document.querySelector(`[data-doc-file="${zone.dataset.docDrop}"]`);
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      showChosenFile(zone.dataset.docDrop, input.files[0]);
    }
  });

  // ---- Proof of invoice: QR and share buttons. Nothing is shared until the freelancer confirms. ----
  function qrSvg(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag(4, 2);
  }

  function showProof(inv, p) {
    const panel = $("proofPanel");
    panel.classList.remove("hidden");
    panel.innerHTML = `
      <h2>Proof for ${esc(inv.number)}</h2>
      <p class="muted">The QR code opens a public page that confirms this invoice was issued. The page shows the invoice number, amount, date and status only.</p>
      <div style="background:#fff;padding:12px;border-radius:12px;max-width:260px;margin:0 auto;">${qrSvg(p.verifyUrl)}</div>
      <p class="muted" style="word-break:break-all;margin-top:10px;">${esc(p.verifyUrl)}</p>
      <label>Message to send<textarea id="proofText" readonly>${esc(p.text)}</textarea></label>
      <label class="check"><input type="checkbox" id="proofConfirm"><span>I have checked the amount, client and invoice number. I approve sending this proof.</span></label>
      <div class="row" style="margin-top:10px;">
        <button class="btn" id="proofWa" disabled>Share on WhatsApp</button>
        <button class="btn ghost" id="proofMail" disabled>Email proof</button>
      </div>`;
    $("proofConfirm").addEventListener("change", e => {
      $("proofWa").disabled = !e.target.checked;
      $("proofMail").disabled = !e.target.checked;
    });
    $("proofWa").addEventListener("click", () => window.open(p.whatsappUrl, "_blank", "noopener"));
    $("proofMail").addEventListener("click", () => { window.location.href = p.mailtoUrl; });
    panel.scrollIntoView({ behavior: "smooth" });
  }

  async function createProof(number, btn) {
    const inv = invoices.find(i => i.number === number);
    if (!inv || !inv.paypalId) { toast("Send the invoice first."); return; }
    btn.disabled = true;
    try {
      showProof(inv, await api(`/api/invoices/${encodeURIComponent(inv.paypalId)}/proof`, {}));
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Shared project: one client, several freelancers, each invoiced for their own share ----
  const projPeople = [{ name: "", email: "", sharePct: 50 }, { name: "", email: "", sharePct: 50 }];
  let projectId = null;
  try { projectId = localStorage.getItem("cp-project"); } catch { projectId = null; }
  const PROJECT_STATUS = { not_invoiced: "Not invoiced yet", sent: "Invoice sent, awaiting payment", paid: "Paid", cancelled: "Cancelled" };

  function renderPeople() {
    $("pPeople").innerHTML = projPeople.map((p, i) => `
      <div class="people">
        <label>Name<input data-pp="${i}" data-f="name" maxlength="60" value="${esc(p.name)}"></label>
        <label>PayPal email<input data-pp="${i}" data-f="email" type="email" value="${esc(p.email)}"></label>
        <label>Share (%)<input data-pp="${i}" data-f="sharePct" type="number" min="0.01" max="100" step="0.01" value="${esc(p.sharePct)}"></label>
        ${projPeople.length > 2 ? `<button class="btn ghost" data-remove="${i}">Remove</button>` : ""}
      </div>`).join("");
    updateShares();
  }

  function updateShares() {
    const total = projPeople.reduce((s, p) => s + (Number(p.sharePct) || 0), 0);
    const ok = Math.abs(total - 100) < 0.01;
    $("pSum").innerHTML = `Shares add up to <strong style="color:${ok ? "var(--ok)" : "var(--bad)"}">${total.toFixed(2)}%</strong>${ok ? "" : " (must be 100%)"}`;
    $("pCreate").disabled = !ok;
  }

  function renderProject(s) {
    const pct = s.totalUsd ? Math.round(s.paidUsd / s.totalUsd * 100) : 0;
    $("projectForm").classList.add("hidden");
    $("projectView").classList.remove("hidden");
    $("projectView").innerHTML = `
      <h2>${esc(s.name)}</h2>
      <div class="muted" style="margin:0;">Total ${usd(s.totalUsd)} · paid ${usd(s.paidUsd)} · still owed ${usd(s.owedUsd)}</div>
      <div class="meter"><span style="width:${pct}%"></span></div>
      ${s.complete ? `<div class="banner" style="background:var(--ok-bg);color:var(--ok)">Everyone has been paid.</div>` : ""}
      ${s.collaborators.map(c => `
        <div class="inv">
          <div class="inv-head">
            <div><div class="inv-title">${esc(c.name)}</div><div class="muted" style="margin:0;">${esc(c.email)} · ${c.sharePct}%</div></div>
            <div class="amt">${usd(c.amountUsd)}</div>
          </div>
          <span class="tag ${c.status === "paid" ? "ok" : c.status === "sent" ? "wait" : "bad"}">${esc(PROJECT_STATUS[c.status] || c.status)}</span>
          ${c.invoiceNumber ? `<span class="muted" style="font-size:12px;"> ${esc(c.invoiceNumber)}</span>` : ""}
        </div>`).join("")}
      <div class="row" style="margin-top:8px;">
        <button class="btn" id="pInvoice" ${s.collaborators.every(c => c.status !== "not_invoiced") ? "disabled" : ""}>Invoice each share</button>
        <button class="btn ghost" id="pRefresh">Refresh</button>
        <button class="btn ghost" id="pNew">New project</button>
      </div>
      <p class="muted" style="margin:10px 0 0;">Each person is invoiced for their own share. The app does not hold any money.</p>`;
  }

  async function createProject() {
    const body = {
      name: $("pName").value.trim(),
      clientName: $("pClient").value.trim() || "Client",
      clientEmail: $("pClientEmail").value.trim(),
      totalUsd: Number($("pTotal").value),
      collaborators: projPeople.map(p => ({ name: String(p.name).trim(), email: String(p.email).trim(), sharePct: Number(p.sharePct) }))
    };
    try {
      const s = await api("/api/projects", body);
      projectId = s.id;
      try { localStorage.setItem("cp-project", projectId); } catch { /* memory only */ }
      renderProject(s);
      toast("Project created. Now invoice each share.");
    } catch (err) {
      toast(err.message);
    }
  }

  async function loadProject() {
    if (!projectId) return;
    try {
      renderProject(await api(`/api/projects/${encodeURIComponent(projectId)}`));
    } catch (err) {
      // Only forget the saved project if it no longer exists. Other errors (such as not signed in yet) keep it.
      if (String(err.message).includes("not found") || String(err.message).includes("404")) {
        projectId = null;
        try { localStorage.removeItem("cp-project"); } catch { /* ignore */ }
      }
    }
  }

  async function invoiceProject() {
    if (!confirm("Send one PayPal invoice to the client for each share? Each invoice is emailed by PayPal.")) return;
    try {
      const res = await api(`/api/projects/${encodeURIComponent(projectId)}/invoices`, {});
      const failed = res.results.filter(r => r.error);
      renderProject(res.project);
      toast(failed.length ? `${failed.length} share(s) could not be sent: ${failed[0].error}` : "Invoices sent for every share.");
    } catch (err) {
      toast(err.message);
    }
  }

  $("pPeople").addEventListener("input", e => {
    const i = e.target.dataset.pp;
    if (i === undefined) return;
    projPeople[Number(i)][e.target.dataset.f] = e.target.value;
    updateShares();
  });
  $("pPeople").addEventListener("click", e => {
    const r = e.target.dataset.remove;
    if (r === undefined) return;
    projPeople.splice(Number(r), 1);
    renderPeople();
  });
  $("pAdd").addEventListener("click", () => {
    if (projPeople.length < 10) { projPeople.push({ name: "", email: "", sharePct: 0 }); renderPeople(); }
  });
  $("pCreate").addEventListener("click", createProject);
  $("projectView").addEventListener("click", e => {
    if (e.target.id === "pInvoice") invoiceProject();
    if (e.target.id === "pRefresh") loadProject();
    if (e.target.id === "pNew") {
      projectId = null;
      try { localStorage.removeItem("cp-project"); } catch { /* ignore */ }
      $("projectView").classList.add("hidden");
      $("projectForm").classList.remove("hidden");
    }
  });
  document.addEventListener("click", e => {
    const proof = e.target.closest("[data-proof]");
    if (proof) createProof(proof.dataset.proof, proof);
  });
  renderPeople();
  loadProject();

  // ---- Live dictation in English, using the browser's built-in speech recognition. ----
  // Audio goes to the browser's speech service. ClearPaid does not receive or store it.
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec) {
    const rec = new SpeechRec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-IN";
    let listening = false;
    rec.onresult = e => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      $("replyText").value = text.trim();
    };
    rec.onend = () => {
      listening = false;
      $("micBtn").textContent = "Speak the message";
    };
    rec.onerror = e => {
      listening = false;
      $("micBtn").textContent = "Speak the message";
      toast(e.error === "not-allowed" ? "Microphone permission was refused." : `Speech not available (${e.error}).`);
    };
    $("micBtn").addEventListener("click", () => {
      if (listening) { rec.stop(); return; }
      listening = true;
      $("micBtn").textContent = "Listening… tap to stop";
      rec.start();
    });
  } else {
    $("micBtn").disabled = true;
    $("micNote").textContent = "Live dictation is not supported in this browser. Upload a voice note instead.";
  }

  // ---- Home overview ----
  function renderHome() {
    const isPaid = i => i.paypalStatus === "PAID";
    const open = invoices.filter(i => !isPaid(i));
    const paid = invoices.filter(isPaid);
    const sum = list => list.reduce((s, i) => s + (Number(i.amountUsd) || 0), 0);
    $("homeStats").innerHTML = [
      ["Still to collect", usd(sum(open)), open.length + " invoice(s) waiting"],
      ["Paid through PayPal", usd(sum(paid)), paid.length + " confirmed by PayPal"],
      ["Invoices on this device", String(invoices.length), "created in ClearPaid"]
    ].map(([label, value, note]) => `<div class="stat-card"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span><span class="stat-note">${esc(note)}</span></div>`).join("");
    api("/api/reminders").then(({ reminders }) => {
      $("homeReminderNote").textContent = reminders.length ? reminders.length + " invoice(s) are overdue. Review them in Reminders." : "No overdue invoices right now.";
    }).catch(() => { $("homeReminderNote").textContent = "Sign in to see overdue invoices."; });
  }

  // ---- Payment reminders: each one waits for the freelancer's approval before PayPal sends it ----
  async function loadReminders() {
    const box = $("reminderList");
    if (!box) return;
    try {
      const { reminders, dailyCap } = await api("/api/reminders");
      $("reminderCap").textContent = "Daily limit: " + dailyCap + " reminders. One reminder per invoice each week.";
      box.innerHTML = reminders.length ? reminders.map(r => `
        <div class="inv">
          <div class="inv-head">
            <div><div class="inv-title">${esc(r.clientName || "Client")}</div><div class="muted" style="margin:0;">${esc(r.number)} · due ${esc(r.dueDate)} · ${Number(r.daysLate)} day(s) late</div></div>
            <div class="amt">${usd(r.amountUsd)}</div>
          </div>
          <div class="row" style="margin-top:10px;">
            <button class="btn" data-remind="approve" data-id="${esc(r.id)}">Approve and send reminder</button>
            <button class="btn ghost" data-remind="snooze" data-id="${esc(r.id)}">Snooze a week</button>
          </div>
        </div>`).join("") : `<div class="empty">Nothing overdue. Every invoice is paid or not yet due.</div>`;
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-remind]");
    if (!b) return;
    const action = b.dataset.remind;
    if (action === "approve" && !confirm("Send this payment reminder through PayPal now?")) return;
    b.disabled = true;
    try {
      await api(`/api/reminders/${encodeURIComponent(b.dataset.id)}/${action}`, {});
      toast(action === "approve" ? "Reminder sent through PayPal" : "Snoozed for a week");
      loadReminders();
      loadActivity();
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  });

  // ---- Details from a scanned bill, carried to the Invoices screen ----
  function applyPrefill() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem("cp-prefill") || "null"); sessionStorage.removeItem("cp-prefill"); } catch { p = null; }
    if (!p) return;
    if (p.amount != null) { $("amountUsd").value = p.amount; $("mAmount").value = p.amount; }
    if (p.clientName) $("clientName").value = p.clientName;
    if (p.clientEmail) $("clientEmail").value = p.clientEmail;
  }

  // ---- PayPal at work: which features are on, and the timeline of PayPal steps ----
  function renderFeatures(list) {
    $("featureChips").innerHTML = (list || []).map(f => `<span class="fchip ${f.on ? "on" : "off"}" title="${esc(f.detail)}">${esc(f.name)}</span>`).join("");
  }
  async function loadActivity() {
    try {
      const { activity } = await api("/api/activity");
      $("activityList").innerHTML = activity.length ? activity.map(a => `
        <div class="tl">
          <span class="dot" aria-hidden="true"></span>
          <div>
            <div class="tl-title">${esc(a.label)} <span class="muted">· ${esc(a.invoice)}</span></div>
            <div class="muted tl-sub">${esc(a.product)} · <code>${esc(a.endpoint)}</code> · ${esc(new Date(a.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }))}</div>
          </div>
        </div>`).join("") : `<div class="empty">No PayPal activity yet. Send an invoice to see it here.</div>`;
    } catch {
      $("activityList").innerHTML = `<div class="empty">Sign in to see PayPal activity.</div>`;
    }
  }

  // Offline support and install prompt. Failure is harmless: the app works without it.
  if (SHELL === "mobile" && "serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});

  $("ledgerMonth").value = new Date().toISOString().slice(0, 7);
  loadInvoices();
  I18N.applyLang(document, lang);
  $("langBtn").textContent = lang === "hi" ? "English" : "हिन्दी";
  renderInvoices();
  renderMoney();
  loadConfig();

  // Demo sign-in returns to the same page, so a preview inside another page stays on its own version.
  document.querySelectorAll('a[href="/auth/demo"]').forEach(a => a.setAttribute("href", "/auth/demo?next=" + encodeURIComponent(location.pathname)));
  applyPrefill();
  showView(currentView());
