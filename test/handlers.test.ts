import assert from "node:assert/strict";
import { test } from "node:test";
import * as m from "../src/models";
import { assertContains, assertInOrder, assertNotContains, count, newTestApp } from "./helpers";

test("login form is shown", async () => {
  const ta = await newTestApp();
  const res = await ta.get("/session/new");
  assert.equal(res.status, 200);
  assertContains(res.body, "Esqueceu a senha?");
});

test("guest is redirected to login and back after signing in", async () => {
  const ta = await newTestApp();
  await ta.createUser("driver@example.com", "secret123");

  assert.equal((await ta.get("/dashboard")).location, "/session/new");
  const res = await ta.post("/session", { email_address: " Driver@Example.com ", password: "secret123" });

  assert.equal(res.location, "/dashboard");
  assert.equal(await count(ta.db, "SELECT count(*) FROM sessions"), 1);
  assert.equal((await ta.get("/dashboard")).status, 200);
});

test("wrong password is rejected", async () => {
  const ta = await newTestApp();
  await ta.createUser("driver@example.com", "secret123");

  const res = await ta.post("/session", { email_address: "driver@example.com", password: "wrong" });

  assert.equal(res.location, "/session/new");
  assertContains((await ta.get("/session/new")).body, "E-mail ou senha inválidos.");
});

test("login attempts are limited to ten every three minutes", async () => {
  const ta = await newTestApp();
  const form = { email_address: "x@example.com", password: "x" };
  for (let i = 0; i < 10; i++) await ta.post("/session", form);
  await ta.post("/session", form);
  assertContains((await ta.get("/session/new")).body, "Tente novamente mais tarde.");

  ta.clock.add(4);
  await ta.post("/session", form);
  assertContains((await ta.get("/session/new")).body, "E-mail ou senha inválidos.");
});

test("sign out deletes the session", async () => {
  const ta = await newTestApp();
  await ta.signIn();

  const res = await ta.post("/session", { _method: "delete" });

  assert.equal(res.status, 303);
  assert.equal(res.location, "/session/new");
  assert.equal(await count(ta.db, "SELECT count(*) FROM sessions"), 0);
  assert.equal((await ta.get("/")).location, "/session/new");
});

test("forms without a valid CSRF token are rejected", async () => {
  const ta = await newTestApp();
  await ta.createUser("driver@example.com", "secret123");

  const res = await ta.post("/session", { authenticity_token: "forged", email_address: "driver@example.com", password: "secret123" });

  assert.equal(res.status, 422);
  assert.equal(await count(ta.db, "SELECT count(*) FROM sessions"), 0);
});

test("registration creates an account and signs in", async () => {
  const ta = await newTestApp();

  const res = await ta.post("/registration", {
    "user[email_address]": " New@Example.com ", "user[password]": "secret123", "user[password_confirmation]": "secret123",
  });

  assert.equal(res.location, "/");
  assert.equal(await count(ta.db, "SELECT count(*) FROM users WHERE email_address = 'new@example.com'"), 1);
  assertContains((await ta.get("/")).body, "Conta criada.");
});

test("registration shows the validation messages", async () => {
  const ta = await newTestApp();

  const res = await ta.post("/registration", { "user[email_address]": "bad", "user[password]": "1", "user[password_confirmation]": "2" });

  assert.equal(res.status, 422);
  assertContains(res.body, "Confirmação da senha não é igual a Senha", "E-mail não é válido");
});

test("password reset email does not reveal whether the address exists", async () => {
  const ta = await newTestApp();
  await ta.createUser("driver@example.com", "secret123");
  const notice = "Se o e-mail estiver cadastrado, enviamos as instruções para redefinir a senha.";

  assert.equal((await ta.post("/passwords", { email_address: "driver@example.com" })).location, "/session/new");
  assertContains((await ta.get("/session/new")).body, notice);
  await ta.post("/passwords", { email_address: "missing@example.com" });
  assertContains((await ta.get("/session/new")).body, notice);

  assert.equal(ta.mailer.sent.length, 1);
  assertContains(ta.mailer.sent[0], "driver@example.com|Redefinição de senha|", "/passwords/", "/edit", "15 minutos");
});

test("password reset changes the password and ends every session", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  const token = ta.app.passwordResetToken(u);

  assertContains((await ta.get(`/passwords/${token}/edit`)).body, "Defina sua nova senha");
  const res = await ta.post(`/passwords/${token}`, { _method: "put", password: "new-secret", password_confirmation: "new-secret" });

  assert.equal(res.location, "/session/new");
  assertContains((await ta.get("/session/new")).body, "Senha redefinida.");
  assert.equal(await count(ta.db, "SELECT count(*) FROM sessions"), 0);
  const reloaded = await m.findUser(ta.db, u.id);
  assert.equal(m.checkPassword(reloaded!, "new-secret"), true);
});

test("password reset rejects passwords that do not match", async () => {
  const ta = await newTestApp();
  const token = ta.app.passwordResetToken(await ta.createUser("driver@example.com", "secret123"));

  const res = await ta.post(`/passwords/${token}`, { _method: "put", password: "new-secret", password_confirmation: "other" });

  assert.equal(res.location, `/passwords/${token}/edit`);
  assertContains((await ta.get(`/passwords/${token}/edit`)).body, "As senhas não conferem ou têm menos de 6 caracteres.");
});

test("password reset token expires after fifteen minutes and after a password change", async () => {
  const ta = await newTestApp();
  const u = await ta.createUser("driver@example.com", "secret123");
  const token = ta.app.passwordResetToken(u);

  ta.clock.add(16);
  assert.equal((await ta.get(`/passwords/${token}/edit`)).location, "/passwords/new");
  assertContains((await ta.get("/passwords/new")).body, "O link de redefinição é inválido ou expirou.");

  ta.clock.add(-16);
  assert.equal((await ta.get(`/passwords/${token}/edit`)).status, 200);
  u.passwordDigest = m.hashPassword("another123", 4);
  await m.updatePassword(ta.db, u);
  assert.equal((await ta.get(`/passwords/${token}/edit`)).location, "/passwords/new");
  assert.equal((await ta.get("/passwords/invalid/edit")).location, "/passwords/new");
});

test("list shows entries and the total balance", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  await ta.createEntry(u, { cents: 15000 });
  await ta.createEntry(u, { kind: m.Debit, cents: 4000 });

  assertContains((await ta.get("/")).body, "Saldo total", "R$ 110,00", "-R$ 40,00");
});

test("list filters by day", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  await ta.createEntry(u, { date: "2026-10-26", cents: 1000 });
  await ta.createEntry(u, { date: "2026-10-27", cents: 2000 });

  const body = (await ta.get("/current_accounts?date=2026-10-26")).body;
  assertContains(body, "Saldo do dia 26/10/2026", "R$ 10,00");
  assertNotContains(body, "R$ 20,00");
});

test("list paginates thirty entries per page", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  for (let n = 1; n <= 31; n++) await ta.createEntry(u, { historic: `entry ${n}.` });

  const first = (await ta.get("/current_accounts")).body;
  assertContains(first, "Mais antigos →", "entry 2.");
  assertNotContains(first, "← Mais recentes", "entry 1.");
  const second = (await ta.get("/current_accounts?page=2")).body;
  assertContains(second, "← Mais recentes", "entry 1.");
  assertNotContains(second, "Mais antigos →", "entry 2.");
});

test("JSON has the jbuilder fields", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  const e = await ta.createEntry(u, { historic: "Café/Almoço" });
  const blank = await ta.createEntry(u, { date: "2026-10-01", cents: 1250 });

  const one = `{"id":${e.id},"cash_account_id":5,"cost_id":6,"date_ocurrence":"2026-10-27","price":"150.0","historic":"Café/Almoço","user_id":${u.id},"type_launche":1,"url":"${ta.url}/current_accounts/${e.id}.json"}`;
  const two = `{"id":${blank.id},"cash_account_id":5,"cost_id":6,"date_ocurrence":"2026-10-01","price":"12.5","historic":null,"user_id":${u.id},"type_launche":1,"url":"${ta.url}/current_accounts/${blank.id}.json"}`;
  assert.equal((await ta.get("/current_accounts.json")).body, `[${one},${two}]`);
  assert.equal((await ta.get(`/current_accounts/${e.id}.json`)).body, one);
});

test("other users' entries are not found", async () => {
  const ta = await newTestApp();
  await ta.signIn();
  const other = await ta.createEntry(await ta.createUser("other@example.com", "secret123"));
  const path = `/current_accounts/${other.id}`;

  assert.equal((await ta.get(path)).status, 404);
  assert.equal((await ta.get(path + "/edit")).status, 404);
  assert.equal((await ta.get(path + ".json")).status, 404);
  assert.equal((await ta.post(path, { _method: "delete" })).status, 404);
  assert.equal(await count(ta.db, "SELECT count(*) FROM current_accounts"), 1);
});

const validEntryForm = (): Record<string, string> => ({
  "current_account[type_launche]": "credito", "current_account[price]": "150", "current_account[date_ocurrence]": "2026-10-27",
  "current_account[cost_id]": "6", "current_account[cash_account_id]": "5", "current_account[historic]": "Corridas do dia",
});

test("create entry", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();

  const res = await ta.post("/current_accounts", validEntryForm());

  assert.equal(res.location, "/current_accounts");
  assertContains((await ta.get("/current_accounts")).body, "Lançamento cadastrado.");
  assert.equal(await count(ta.db, "SELECT count(*) FROM current_accounts WHERE user_id = $1 AND price = 150 AND type_launche = 1", [u.id]), 1);
});

test("create entry ignores a user_id sent in the form", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  const other = await ta.createUser("other@example.com", "secret123");

  await ta.post("/current_accounts", { ...validEntryForm(), "current_account[user_id]": String(other.id) });

  assert.equal(await count(ta.db, "SELECT count(*) FROM current_accounts WHERE user_id = $1", [u.id]), 1);
});

test("create entry shows the validation messages", async () => {
  const ta = await newTestApp();
  await ta.signIn();

  const res = await ta.post("/current_accounts", { "current_account[price]": "" });

  assert.equal(res.status, 422);
  assertContains(res.body, "Valor não pode ficar em branco", "Tipo não está incluído na lista", "<option value=\"\">Selecione</option>");
});

test("update entry", async () => {
  const ta = await newTestApp();
  const e = await ta.createEntry(await ta.signIn());

  const res = await ta.post(`/current_accounts/${e.id}`, { ...validEntryForm(), _method: "patch", "current_account[price]": "12.5" });

  assert.equal(res.location, `/current_accounts/${e.id}`);
  assertContains((await ta.get(res.location)).body, "Lançamento atualizado.", "R$ 12,50");
});

test("update entry keeps the fields missing from the form", async () => {
  const ta = await newTestApp();
  const e = await ta.createEntry(await ta.signIn(), { historic: "kept" });

  const res = await ta.post(`/current_accounts/${e.id}`, { _method: "patch", "current_account[price]": "" });

  assert.equal(res.status, 422);
  assertContains(res.body, "Valor não pode ficar em branco", 'value="kept"');
  assertNotContains(res.body, "Tipo não está incluído na lista", "Selecione");
});

test("delete entry", async () => {
  const ta = await newTestApp();
  const e = await ta.createEntry(await ta.signIn());

  const res = await ta.post(`/current_accounts/${e.id}`, { _method: "delete" });

  assert.equal(res.status, 303);
  assertContains((await ta.get("/current_accounts")).body, "Lançamento removido.");
  assert.equal(await count(ta.db, "SELECT count(*) FROM current_accounts"), 0);
});

test("legacy daily search redirects to the filter", async () => {
  const ta = await newTestApp();
  const res = await ta.get("/search_account?date_calendar_now=2026-10-27");
  assert.equal(res.status, 301);
  assert.equal(res.location, "/current_accounts?date=2026-10-27");
});

test("dashboard shows the daily and monthly balances", async () => {
  const ta = await newTestApp();
  const u = await ta.signIn();
  await ta.createEntry(u, { date: "2026-10-02", cents: 20000 });
  await ta.createEntry(u, { date: "2026-10-02", kind: m.Debit, cost: 0, cents: 5000 });
  await ta.createEntry(u, { date: "2026-10-05", kind: m.Debit, cost: 8, cents: 2000 });
  await ta.createEntry(u, { date: "2026-09-30", cents: 99900 });

  const body = (await ta.get("/dashboard?month=2026-10")).body;

  assertContains(body, "Outubro de 2026", "Saldo Diário", "Saldo Mensal");
  assertInOrder(body, "05/10/2026", "-R$ 20,00", "02/10/2026", "R$ 150,00", "Total do mês", "R$ 130,00");
  assertInOrder(body, "Corridas", "R$ 200,00", "Combustível", "-R$ 50,00", "Lavagem", "-R$ 20,00", "Telefone", "R$ 0,00", "Saldo do mês", "R$ 130,00");
  assertNotContains(body, "999");
});

test("dashboard links to the previous and next months", async () => {
  const ta = await newTestApp();
  await ta.signIn();
  assertContains((await ta.get("/dashboard?month=2026-01")).body, "/dashboard?month=2025-12", "/dashboard?month=2026-02");
});

test("dashboard falls back to the current month", async () => {
  const ta = await newTestApp();
  await ta.signIn();
  ta.clock.now = new Date("2026-03-15T12:00:00-03:00");
  assertContains((await ta.get("/dashboard?month=bad")).body, "Março de 2026");
  assertContains((await ta.get("/dashboard?month=2026-13")).body, "Março de 2026");
});
