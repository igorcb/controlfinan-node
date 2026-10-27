import bcrypt from "bcryptjs";
import { Pool, types } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dateBR, decimalText, parseCents } from "./format";

// SQL dates come back as "YYYY-MM-DD" strings (no time zone shifts) and bigints as numbers.
types.setTypeParser(1082, (value: string) => value);
types.setTypeParser(20, (value: string) => Number(value));

export interface Option {
  id: number;
  name: string;
}

export const CashAccounts: Option[] = [
  { id: 0, name: "Conta Dinheiro" }, { id: 1, name: "Itaú" }, { id: 2, name: "Santander" }, { id: 3, name: "CEF Poupança" },
  { id: 4, name: "PagSeguro" }, { id: 5, name: "Uber" }, { id: 6, name: "Platinum Itaú" }, { id: 7, name: "Banco do Brasil" },
  { id: 8, name: "99Pop" },
];

export const Costs: Option[] = [
  { id: 0, name: "Combustível" }, { id: 1, name: "Central" }, { id: 2, name: "Aluguel Carro" }, { id: 3, name: "Almoço" },
  { id: 4, name: "Lanche" }, { id: 5, name: "Diversos" }, { id: 6, name: "Corridas" }, { id: 7, name: "Telefone" },
  { id: 8, name: "Lavagem" }, { id: 9, name: "Transferência" }, { id: 10, name: "Depósitos" }, { id: 11, name: "Estacionamento" },
  { id: 12, name: "Impostos" }, { id: 13, name: "Multas" }, { id: 14, name: "Manutenção" }, { id: 15, name: "Viagens Uber" },
];

export const Debit = -1;
export const Credit = 1;
export const Rides = 6;
// Unset marks an integer form field that was blank or invalid.
export const Unset = -1;

// RideExpenses are discounted from the rides in the monthly balance (legacy dashboard rule), in this order.
export const RideExpenses: Option[] = [{ id: 0, name: "Combustível" }, { id: 8, name: "Lavagem" }, { id: 7, name: "Telefone" }];

// Same regexp as Ruby's URI::MailTo::EMAIL_REGEXP.
const emailRegexp =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function optionName(options: Option[], id: number): string {
  return options.find((option) => option.id === id)?.name ?? "Não definido";
}

function hasOption(options: Option[], id: number): boolean {
  return options.some((option) => option.id === id);
}

export function createPool(connectionString: string, max: number): Pool {
  return new Pool({ connectionString, max });
}

// migrate creates the tables (same schema as the Rails app) when they do not exist.
export async function migrate(db: Pool): Promise<void> {
  await db.query(readFileSync(join(__dirname, "..", "..", "src", "schema.sql"), "utf8"));
}

// User mirrors the Rails users table (has_secure_password).
export interface User {
  id: number;
  emailAddress: string;
  passwordDigest: string;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// hashPassword writes the same "$2a$" format as Rails. bcrypt only uses the first 72 bytes, like Rails.
export function hashPassword(raw: string, cost: number): string {
  return bcrypt.hashSync(raw, cost).replace(/^\$2b\$/, "$2a$");
}

export function checkPassword(user: Pick<User, "passwordDigest">, raw: string): boolean {
  if (raw === "") return false;
  try {
    return bcrypt.compareSync(raw, user.passwordDigest);
  } catch {
    return false;
  }
}

// validateUser returns the Rails messages (pt-BR) in the same order.
export async function validateUser(
  db: Pool, user: { id?: number; emailAddress: string }, password: string | null, confirmation: string | null, passwordRequired: boolean,
): Promise<string[]> {
  const errs: string[] = [];
  if (passwordRequired && !password) errs.push("Senha não pode ficar em branco");
  if (password !== null && confirmation !== null && password !== confirmation) errs.push("Confirmação da senha não é igual a Senha");
  user.emailAddress = normalizeEmail(user.emailAddress);
  if (user.emailAddress === "") {
    errs.push("E-mail não pode ficar em branco");
  } else if (!emailRegexp.test(user.emailAddress)) {
    errs.push("E-mail não é válido");
  } else {
    const { rows } = await db.query("SELECT EXISTS (SELECT 1 FROM users WHERE email_address = $1 AND id <> $2) AS taken", [
      user.emailAddress, user.id ?? 0,
    ]);
    if (rows[0].taken) errs.push("E-mail já está em uso");
  }
  if (password && [...password].length < 6) errs.push("Senha é muito curto (mínimo: 6 caracteres)");
  return errs;
}

function toUser(row: { id: number; email_address: string; password_digest: string } | undefined): User | null {
  return row ? { id: row.id, emailAddress: row.email_address, passwordDigest: row.password_digest } : null;
}

export async function findUserByEmail(db: Pool, email: string): Promise<User | null> {
  const { rows } = await db.query("SELECT id, email_address, password_digest FROM users WHERE email_address = $1", [normalizeEmail(email)]);
  return toUser(rows[0]);
}

export async function findUser(db: Pool, id: number): Promise<User | null> {
  const { rows } = await db.query("SELECT id, email_address, password_digest FROM users WHERE id = $1", [id]);
  return toUser(rows[0]);
}

export async function createUser(db: Pool, user: User): Promise<void> {
  const { rows } = await db.query(
    "INSERT INTO users (email_address, password_digest, created_at, updated_at) VALUES ($1, $2, now(), now()) RETURNING id",
    [user.emailAddress, user.passwordDigest],
  );
  user.id = rows[0].id;
}

export async function updatePassword(db: Pool, user: User): Promise<void> {
  await db.query("UPDATE users SET password_digest = $1, updated_at = now() WHERE id = $2", [user.passwordDigest, user.id]);
}

// Entry is a row of current_accounts (a credit or a debit).
export class Entry {
  id = 0;
  userId = 0;
  cashAccountId = Unset;
  costId = Unset;
  typeLaunche = 0;
  date = ""; // "YYYY-MM-DD", empty when not set
  priceCents = 0;
  priceSet = false;
  priceText = ""; // raw form value, used by the validation like Rails numericality
  historic: string | null = null;

  constructor(attrs: Partial<Entry> = {}) {
    Object.assign(this, attrs);
  }

  get persisted(): boolean { return this.id !== 0; }
  get isCredit(): boolean { return this.typeLaunche === Credit; }
  get nameAccount(): string { return optionName(CashAccounts, this.cashAccountId); }
  get nameCost(): string { return optionName(Costs, this.costId); }
  get dateBR(): string { return dateBR(this.date); }
  get dayMonth(): string { return this.date.slice(8, 10) + "/" + this.date.slice(5, 7); }
  get typeName(): string { return this.isCredit ? "Crédito" : "Débito"; }
  get signedCents(): number { return this.isCredit ? this.priceCents : -this.priceCents; }
  get historicText(): string { return this.historic ?? ""; }

  // priceField is the value shown in the form: the decimal like Rails, or what the user typed.
  get priceField(): string { return this.priceSet ? decimalText(this.priceCents) : this.priceText; }

  // validate returns the Rails messages (pt-BR) in the same order as the model validations.
  validate(): string[] {
    const errs: string[] = [];
    if (this.typeLaunche !== Debit && this.typeLaunche !== Credit) errs.push("Tipo não está incluído na lista");
    if (!hasOption(CashAccounts, this.cashAccountId)) errs.push("Conta não está incluído na lista");
    if (!hasOption(Costs, this.costId)) errs.push("Categoria não está incluído na lista");
    if (this.date === "") errs.push("Data não pode ficar em branco");
    // Like Rails presence + numericality: a blank value is also "not a number".
    if (!this.priceSet && this.priceText === "") errs.push("Valor não pode ficar em branco", "Valor não é um número");
    else if (!this.priceSet) errs.push("Valor não é um número");
    else if (this.priceCents <= 0) errs.push("Valor deve ser maior que 0");
    return errs;
  }
}

const entryColumns = "id, user_id, cash_account_id, cost_id, type_launche, date_ocurrence, price::text AS price, historic";

interface EntryRow {
  id: number; user_id: number; cash_account_id: number; cost_id: number; type_launche: number;
  date_ocurrence: string; price: string; historic: string | null;
}

function toEntry(row: EntryRow): Entry {
  return new Entry({
    id: row.id, userId: row.user_id, cashAccountId: row.cash_account_id, costId: row.cost_id, typeLaunche: row.type_launche,
    date: row.date_ocurrence, priceCents: parseCents(row.price), priceSet: true, historic: row.historic,
  });
}

// listEntries returns up to limit entries, most recent first, optionally on one day.
export async function listEntries(db: Pool, userId: number, day: string | null, limit: number, offset: number): Promise<Entry[]> {
  let query = "SELECT " + entryColumns + " FROM current_accounts WHERE user_id = $1";
  const args: unknown[] = [userId];
  if (day) {
    query += " AND date_ocurrence = $2";
    args.push(day);
  }
  query += ` ORDER BY date_ocurrence DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await db.query(query, args);
  return rows.map(toEntry);
}

// balance is credits minus debits: the sign comes from type_launche (-1 or 1).
export async function balance(db: Pool, userId: number, day: string | null): Promise<number> {
  let query = "SELECT COALESCE(SUM(price * type_launche), 0)::text AS total FROM current_accounts WHERE user_id = $1";
  const args: unknown[] = [userId];
  if (day) {
    query += " AND date_ocurrence = $2";
    args.push(day);
  }
  const { rows } = await db.query(query, args);
  return parseCents(rows[0].total);
}

export async function findEntry(db: Pool, userId: number, id: number): Promise<Entry | null> {
  const { rows } = await db.query("SELECT " + entryColumns + " FROM current_accounts WHERE user_id = $1 AND id = $2", [userId, id]);
  return rows[0] ? toEntry(rows[0]) : null;
}

export async function saveEntry(db: Pool, e: Entry): Promise<void> {
  const price = decimalText(e.priceCents);
  if (e.persisted) {
    await db.query(
      `UPDATE current_accounts SET cash_account_id = $1, cost_id = $2, type_launche = $3,
       date_ocurrence = $4, price = $5, historic = $6, updated_at = now() WHERE id = $7 AND user_id = $8`,
      [e.cashAccountId, e.costId, e.typeLaunche, e.date, price, e.historic, e.id, e.userId],
    );
    return;
  }
  const { rows } = await db.query(
    `INSERT INTO current_accounts
     (user_id, cash_account_id, cost_id, type_launche, date_ocurrence, price, historic, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) RETURNING id`,
    [e.userId, e.cashAccountId, e.costId, e.typeLaunche, e.date, price, e.historic],
  );
  e.id = rows[0].id;
}

export async function deleteEntry(db: Pool, e: Entry): Promise<void> {
  await db.query("DELETE FROM current_accounts WHERE id = $1 AND user_id = $2", [e.id, e.userId]);
}

// Row is a label and an amount in the dashboard tables.
export interface Row {
  label: string;
  cents: number;
}

// MonthSummary holds the dashboard numbers of one month.
export interface MonthSummary {
  daily: Row[]; // balance of each day, most recent first
  monthBalance: number;
  monthly: Row[]; // rides, then each ride expense as a negative amount
  ridesNet: number;
}

// summarizeMonth takes the first day of the month as {year, month (1-12)}.
export async function summarizeMonth(db: Pool, userId: number, year: number, month: number): Promise<MonthSummary> {
  const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = first.slice(0, 8) + String(lastDay).padStart(2, "0");
  const summary: MonthSummary = { daily: [], monthBalance: 0, monthly: [], ridesNet: 0 };

  const daily = await db.query(
    `SELECT date_ocurrence, SUM(price * type_launche)::text AS total FROM current_accounts
     WHERE user_id = $1 AND date_ocurrence BETWEEN $2 AND $3 GROUP BY date_ocurrence ORDER BY date_ocurrence DESC`,
    [userId, first, last],
  );
  for (const row of daily.rows) {
    const cents = parseCents(row.total);
    summary.daily.push({ label: dateBR(row.date_ocurrence), cents });
    summary.monthBalance += cents;
  }

  const expenses = new Map<number, number>();
  const costs = await db.query(
    `SELECT cost_id, SUM(price)::text AS total FROM current_accounts
     WHERE user_id = $1 AND date_ocurrence BETWEEN $2 AND $3 AND cost_id = ANY($4) GROUP BY cost_id`,
    [userId, first, last, [0, 8, 7]],
  );
  for (const row of costs.rows) expenses.set(row.cost_id, parseCents(row.total));

  const rides = await db.query(
    `SELECT COALESCE(SUM(price * type_launche), 0)::text AS total FROM current_accounts
     WHERE user_id = $1 AND date_ocurrence BETWEEN $2 AND $3 AND cost_id = $4`,
    [userId, first, last, Rides],
  );
  const ridesCents = parseCents(rides.rows[0].total);
  summary.monthly.push({ label: "Corridas", cents: ridesCents });
  summary.ridesNet = ridesCents;
  for (const expense of RideExpenses) {
    const cents = expenses.get(expense.id) ?? 0;
    summary.monthly.push({ label: expense.name, cents: -cents });
    summary.ridesNet -= cents;
  }
  return summary;
}
