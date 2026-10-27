import assert from "node:assert/strict";
import { test } from "node:test";
import { currency, decimalText, parseCents } from "../src/format";
import * as m from "../src/models";
import { Entry } from "../src/models";
import { newTestApp } from "./helpers";

test("currency formats like Rails in Portuguese", () => {
  const cases: [number, string][] = [[123450, "R$ 1.234,50"], [-1250, "-R$ 12,50"], [0, "R$ 0,00"], [5, "R$ 0,05"], [123456789, "R$ 1.234.567,89"]];
  for (const [cents, want] of cases) assert.equal(currency(cents), want);
});

test("decimalText prints like Ruby BigDecimal", () => {
  const cases: [number, string][] = [[15000, "150.0"], [1250, "12.5"], [5, "0.05"], [1234, "12.34"], [-1250, "-12.5"]];
  for (const [cents, want] of cases) assert.equal(decimalText(cents), want);
});

test("parseCents reads Postgres numeric text", () => {
  const cases: [string, number][] = [["150.00", 15000], ["-12.5", -1250], ["0", 0], ["7.05", 705]];
  for (const [text, want] of cases) assert.equal(parseCents(text), want);
});

test("user password uses the Rails bcrypt format", () => {
  const user = { passwordDigest: m.hashPassword("secret123", 4) };
  assert.ok(user.passwordDigest.startsWith("$2a$"), `digest ${user.passwordDigest} should start with $2a$`);
  assert.equal(m.checkPassword(user, "secret123"), true);
  assert.equal(m.checkPassword(user, "wrong"), false);
  assert.equal(m.checkPassword(user, ""), false);
});

test("password longer than 72 bytes is truncated like Rails", () => {
  const user = { passwordDigest: m.hashPassword("é".repeat(40), 4) }; // 80 bytes
  assert.equal(m.checkPassword(user, "é".repeat(36) + "x"), true);
});

test("user accepts a digest written by Rails", () => {
  // Digest of "benchmark123" written by the Rails app (has_secure_password, bcrypt-ruby) for its benchmark account.
  const user = { passwordDigest: "$2a$12$xUBQqXOC4yO3ZUCU3U./FeJ/CU4pqmbNxFQ5iUUrWzLWmKSpUKChe" };
  assert.equal(m.checkPassword(user, "benchmark123"), true);
  assert.equal(m.checkPassword(user, "wrong"), false);
});

test("validateUser returns the Rails messages", async () => {
  const ta = await newTestApp();
  await ta.createUser("taken@example.com", "secret123");

  let errs = await m.validateUser(ta.db, { emailAddress: "" }, "", "", true);
  assert.equal(errs.join("|"), "Senha não pode ficar em branco|E-mail não pode ficar em branco");

  errs = await m.validateUser(ta.db, { emailAddress: "bad" }, "123", "456", true);
  assert.equal(errs.join("|"), "Confirmação da senha não é igual a Senha|E-mail não é válido|Senha é muito curto (mínimo: 6 caracteres)");

  errs = await m.validateUser(ta.db, { emailAddress: " TAKEN@example.com " }, "secret123", "secret123", true);
  assert.equal(errs.join("|"), "E-mail já está em uso");
});

test("entry validate returns the Rails messages", () => {
  let e = new Entry({ cashAccountId: m.Unset, costId: m.Unset });
  assert.equal(e.validate().join("|"),
    "Tipo não está incluído na lista|Conta não está incluído na lista|Categoria não está incluído na lista|" +
    "Data não pode ficar em branco|Valor não pode ficar em branco|Valor não é um número");

  e = new Entry({ cashAccountId: 0, costId: 0, typeLaunche: m.Debit, date: "2026-10-27", priceSet: true, priceCents: 0 });
  assert.equal(e.validate().join("|"), "Valor deve ser maior que 0");

  e = new Entry({ cashAccountId: 99, costId: 99, typeLaunche: m.Credit, date: "2026-10-27", priceText: "abc" });
  assert.equal(e.validate().join("|"), "Conta não está incluído na lista|Categoria não está incluído na lista|Valor não é um número");
});

test("entry names fall back to Não definido", () => {
  const e = new Entry({ cashAccountId: 1, costId: 99, typeLaunche: m.Debit, priceCents: 1000 });
  assert.equal(e.nameAccount, "Itaú");
  assert.equal(e.nameCost, "Não definido");
  assert.equal(e.typeName, "Débito");
  assert.equal(e.signedCents, -1000);
});

test("balance is credits minus debits", async () => {
  const ta = await newTestApp();
  const u = await ta.createUser("driver@example.com", "secret123");
  await ta.createEntry(u, { cents: 15000 });
  await ta.createEntry(u, { kind: m.Debit, cents: 4050 });

  assert.equal(await m.balance(ta.db, u.id, null), 10950);
});

test("summarizeMonth groups by day and discounts ride expenses", async () => {
  const ta = await newTestApp();
  const u = await ta.createUser("driver@example.com", "secret123");
  await ta.createEntry(u, { date: "2026-10-02", cents: 20000 });
  await ta.createEntry(u, { date: "2026-10-02", kind: m.Debit, cost: 0, cents: 5000 });
  await ta.createEntry(u, { date: "2026-10-05", kind: m.Debit, cost: 8, cents: 2000 });
  await ta.createEntry(u, { date: "2026-09-30", cents: 99900 });

  const s = await m.summarizeMonth(ta.db, u.id, 2026, 10);
  assert.deepEqual(s.daily, [{ label: "05/10/2026", cents: -2000 }, { label: "02/10/2026", cents: 15000 }]);
  assert.equal(s.monthBalance, 13000);
  assert.deepEqual(s.monthly.map((r) => [r.label, r.cents + 0]), [["Corridas", 20000], ["Combustível", -5000], ["Lavagem", -2000], ["Telefone", 0]]);
  assert.equal(s.ridesNet, 13000);
});
