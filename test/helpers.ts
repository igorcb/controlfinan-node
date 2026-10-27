// Tests run against a real Postgres database (TEST_DATABASE_URL), emptied before each test,
// with the real server on a random port and an HTTP client that keeps cookies and does not follow redirects.
import assert from "node:assert/strict";
import { after } from "node:test";
import { Pool } from "pg";
import * as m from "../src/models";
import { Entry, User } from "../src/models";
import { buildServer } from "../src/server";

const databaseURL = process.env.TEST_DATABASE_URL || "postgres://app:app@localhost:5432/controlfinan_node_test";
let pool: Pool | null = null;

export async function testDB(): Promise<Pool> {
  if (pool) return pool;
  const admin = new Pool({ connectionString: databaseURL.replace(/\/controlfinan_node_test$/, "/postgres"), max: 1 });
  try {
    await admin.query("CREATE DATABASE controlfinan_node_test");
  } catch {
    // already exists
  } finally {
    await admin.end();
  }
  pool = new Pool({ connectionString: databaseURL, max: 5 });
  await m.migrate(pool);
  return pool;
}

after(async () => {
  await pool?.end();
});

export class FakeMailer {
  sent: string[] = [];
  send(to: string, subject: string, text: string) {
    this.sent.push(`${to}|${subject}|${text}`);
  }
}

// Clock lets a test move time forward.
export class Clock {
  now = new Date("2026-10-27T12:00:00-03:00");
  add(minutes: number) {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }
}

export interface Response {
  status: number;
  body: string;
  location: string;
}

// Client keeps cookies like a browser and never follows redirects.
export class Client {
  cookies = new Map<string, string>();

  constructor(private base: string) {}

  async request(method: string, path: string, form?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.base + path, { method, headers, body, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0/.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return { status: res.status, body: await res.text(), location: (res.headers.get("location") ?? "").replace(this.base, "") };
  }
}

export interface TestApp {
  url: string;
  db: Pool;
  app: ReturnType<typeof buildServer>;
  client: Client;
  mailer: FakeMailer;
  clock: Clock;
  get(path: string): Promise<Response>;
  post(path: string, form?: Record<string, string>): Promise<Response>;
  createUser(email: string, password: string): Promise<User>;
  signIn(): Promise<User>;
  createEntry(user: User, attrs?: EntryAttrs): Promise<Entry>;
}

export interface EntryAttrs {
  date?: string;
  cost?: number;
  kind?: number;
  cents?: number;
  historic?: string;
}

export async function newTestApp(): Promise<TestApp> {
  const db = await testDB();
  await db.query("TRUNCATE sessions, current_accounts, users RESTART IDENTITY CASCADE");
  const clock = new Clock();
  const mailer = new FakeMailer();
  const app = buildServer({ db, secret: "test-secret", bcryptCost: 4, mailer, timeZone: "America/Sao_Paulo", now: () => clock.now });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  after(() => app.close());
  const client = new Client(url);

  const ta: TestApp = {
    url, db, app, client, mailer, clock,
    get: (path) => client.request("GET", path),
    // post sends a form like the browser does, with the CSRF token from the cookie.
    async post(path, form = {}) {
      form = { ...form };
      if (!form.authenticity_token) {
        if (!client.cookies.has("_csrf_token")) await client.request("GET", "/passwords/new"); // any page with a form sets it
        form.authenticity_token = client.cookies.get("_csrf_token") ?? "";
      }
      return client.request("POST", path, form);
    },
    async createUser(email, password) {
      const user: User = { id: 0, emailAddress: email, passwordDigest: m.hashPassword(password, 4) };
      await m.createUser(db, user);
      return user;
    },
    // signIn creates a user and signs in through the real login form.
    async signIn() {
      const user = await ta.createUser("driver@example.com", "secret123");
      const res = await ta.post("/session", { email_address: "driver@example.com", password: "secret123" });
      assert.equal(res.status, 302, "sign in failed");
      return user;
    },
    async createEntry(user, attrs = {}) {
      const kind = attrs.kind ?? m.Credit;
      const e = new Entry({
        userId: user.id, cashAccountId: 5, costId: attrs.cost ?? (kind === m.Credit ? m.Rides : 0), typeLaunche: kind,
        date: attrs.date ?? "2026-10-27", priceCents: attrs.cents ?? 15000, priceSet: true, historic: attrs.historic ?? null,
      });
      await m.saveEntry(db, e);
      return e;
    },
  };
  return ta;
}

export function assertContains(body: string, ...texts: string[]) {
  for (const text of texts) assert.ok(body.includes(text), `expected body to contain ${JSON.stringify(text)}`);
}

export function assertNotContains(body: string, ...texts: string[]) {
  for (const text of texts) assert.ok(!body.includes(text), `expected body not to contain ${JSON.stringify(text)}`);
}

export function assertInOrder(body: string, ...texts: string[]) {
  let from = 0;
  for (const text of texts) {
    const at = body.indexOf(text, from);
    assert.ok(at >= 0, `expected body to contain in order: ${JSON.stringify(texts)} (missing ${JSON.stringify(text)})`);
    from = at + text.length;
  }
}

export async function count(db: Pool, query: string, args: unknown[] = []): Promise<number> {
  const { rows } = await db.query(query, args);
  return Number(Object.values(rows[0])[0]);
}
