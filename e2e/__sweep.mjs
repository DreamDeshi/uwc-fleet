import { chromium } from "playwright";
const API = "https://uwc-api-demo-production.up.railway.app/api/v1";
const PW = process.env.DEMO_PASSWORD;
const PHONE = "+60100000101";
const login = async () => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: PHONE, password: PW }) })).json()).accessToken;
const setLang = async (t, lang) => (await fetch(API + "/users/me", { method: "PATCH", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ language_pref: lang }) })).status;

const LABELS = { en: ["Home","Trips","My Stats","Profile"], ms: ["Utama","Trip","Statistik Saya","Profil"], zh: ["首页","行程","我的数据","我的"] };

const token = await login();
const b = await chromium.launch({ args: ["--disable-web-security"] });
// ONE page for all three passes — exactly what the sweep does.
const p = await b.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US" });

for (const lang of ["en", "ms", "zh"]) {
  console.log(`\n── pass: ${lang} (PATCH → ${await setLang(token, lang)})`);
  await p.goto("http://127.0.0.1:4199", { waitUntil: "networkidle" });
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await p.reload({ waitUntil: "networkidle" });
  await p.getByPlaceholder("12-345 6789").fill("100000101");
  await p.getByPlaceholder("Enter your password").fill(PW);
  await p.getByText("Sign In", { exact: true }).click();
  await p.waitForTimeout(7000);
  for (const label of LABELS[lang]) {
    const n = await p.getByText(label, { exact: true }).locator("visible=true").count();
    console.log(`   "${label}": ${n > 0 ? "found" : "MISSING"}`);
  }
}
await b.close();
