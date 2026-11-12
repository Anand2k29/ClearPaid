const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildAll, SCREENS, VIEWS, FREELANCER } = require("../scripts/build-shells.js");
const { DICT } = require("../freelancer/lib/i18n.js");

const read = rel => fs.readFileSync(path.join(FREELANCER, rel), "utf8");
const idsIn = html => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

// Ids the app script reads. Proof buttons are created at runtime; the More controls exist only in the mobile app.
const RUNTIME_IDS = new Set(["proofConfirm", "proofWa", "proofMail"]);
const MOBILE_ONLY_IDS = new Set(["moreBtn", "moreSheet", "moreClose"]);
function appIds() {
  const js = read("shared/app.js");
  const ids = new Set([...js.matchAll(/\$\("([A-Za-z]+)"\)/g)].map(m => m[1]));
  return [...ids].filter(id => !RUNTIME_IDS.has(id));
}

test("generated pages are current: rerun node scripts/build-shells.js after editing freelancer/shared", () => {
  for (const [rel, html] of buildAll()) {
    assert.equal(read(rel), html, `${rel} is out of date. Run: node scripts/build-shells.js`);
  }
});

test("the mobile app and every desktop page have each element the app script reads", () => {
  const ids = appIds();
  assert.ok(ids.length > 40, "the app script should read many ids");
  const mobile = idsIn(read("mobile/index.html"));
  for (const id of ids) assert.ok(mobile.has(id), `mobile app is missing #${id}`);
  for (const s of SCREENS) {
    const desktop = idsIn(read("desktop/" + s.file));
    for (const id of ids) {
      if (!MOBILE_ONLY_IDS.has(id)) assert.ok(desktop.has(id), `desktop/${s.file} is missing #${id}`);
    }
  }
});

test("every screen has a panel in both sites", () => {
  for (const view of VIEWS) {
    assert.match(read("mobile/index.html"), new RegExp(`data-view-panel="${view}"`), `mobile: ${view}`);
    for (const s of SCREENS) {
      assert.match(read("desktop/" + s.file), new RegExp(`data-view-panel="${view}"`), `desktop/${s.file}: ${view}`);
    }
  }
});

test("every screen can be reached from navigation in both sites", () => {
  const mobile = read("mobile/index.html");
  for (const view of VIEWS) {
    assert.match(mobile, new RegExp(`data-nav="${view}"`), `mobile navigation: ${view}`);
    for (const s of SCREENS) {
      assert.match(read("desktop/" + s.file), new RegExp(`data-nav="${view}"`), `desktop/${s.file} navigation: ${view}`);
    }
  }
});

test("the mobile tab bar has five screens and More, and the rest sit in the More sheet", () => {
  const mobile = read("mobile/index.html");
  const tabbar = mobile.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  const tabs = [...tabbar.matchAll(/data-nav="([a-z]+)"|id="moreBtn"/g)].map(m => m[1] || "more");
  assert.deepEqual(tabs, ["home", "invoices", "scan", "replies", "money", "more"]);
  const sheet = mobile.match(/<div class="sheet[\s\S]*?<\/div>\s*<\/div>/)[0];
  for (const view of ["reminders", "projects", "activity"]) {
    assert.match(sheet, new RegExp(`data-nav="${view}"`), `More sheet: ${view}`);
  }
});

test("each desktop page opens on its own screen, and the others are hidden until the script runs", () => {
  for (const s of SCREENS) {
    const html = read("desktop/" + s.file);
    assert.match(html, new RegExp(`data-view="${s.view}"`), s.file);
    const visible = [...html.matchAll(/<section class="panel( hidden)?" data-view-panel="([a-z]+)">/g)]
      .filter(m => !m[1]).map(m => m[2]);
    assert.deepEqual(visible, [s.view], `${s.file} should show only ${s.view}`);
  }
});

test("the mobile app shows only the home screen before the script runs", () => {
  const visible = [...read("mobile/index.html").matchAll(/<section class="panel( hidden)?" data-view-panel="([a-z]+)">/g)]
    .filter(m => !m[1]).map(m => m[2]);
  assert.deepEqual(visible, ["home"]);
});

test("every translation key the screens use exists in English and Hindi", () => {
  const sources = ["shared/common.html", "shared/views.html", "shared/mobile.html", "shared/desktop.html"].map(read).join("\n");
  const keys = new Set([...sources.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map(m => m[1]));
  assert.ok(keys.size > 20);
  for (const key of keys) {
    assert.ok(key in DICT.en, `en is missing ${key}`);
    assert.ok(key in DICT.hi, `hi is missing ${key}`);
  }
});

test("the shared script loads after the calculator and the helper libraries", () => {
  for (const rel of ["mobile/index.html", "desktop/index.html"]) {
    const html = read(rel);
    const calc = html.indexOf('src="../calc.js"');
    const app = html.indexOf('src="../shared/app.js"');
    assert.ok(calc > 0 && app > calc, rel);
  }
});

test("every file the service worker caches exists, because cache.addAll fails if one is missing", () => {
  const shell = read("sw.js").match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const files = [...shell.matchAll(/"\.\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(files.length >= 8);
  for (const f of files) assert.ok(fs.existsSync(path.join(FREELANCER, f)), `sw.js caches missing file ${f}`);
});

test("the mobile app manifest starts the mobile app and its icons exist", () => {
  const manifest = JSON.parse(read("mobile/manifest.webmanifest"));
  const base = path.join(FREELANCER, "mobile");
  assert.ok(fs.existsSync(path.resolve(base, manifest.start_url)), "start_url");
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.resolve(base, icon.src)), `icon ${icon.src}`);
  }
});

test("the chooser sends each device to the right site and keeps both links", () => {
  const html = read("index.html");
  assert.match(html, /mobile\/index\.html/);
  assert.match(html, /desktop\/index\.html/);
  assert.match(html, /min-width: 900px/);
});
