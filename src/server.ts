import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { Pool } from "pg";
import { decimalText, parseDate, todayIn, dateBR } from "./format";
import * as m from "./models";
import { Entry, User } from "./models";
import * as views from "./views/templates";
import {
  Flash, RateLimiter, cookieHeader, csrfCookie, flashCookie, hmac, newCSRFToken, parseCookies, permanentAge, returnToCookie,
  safeEqual, sessionCookie, sign, verify,
} from "./web";

export const PER_PAGE = 30;
const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const passwordResetMaxAge = 15 * 60; // seconds

// Mailer delivers the password reset e-mail. The default one writes it to the log.
export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void> | void;
}

export const logMailer: Mailer = {
  send(to, subject, text) {
    console.log(`mail to=${to} subject=${JSON.stringify(subject)}\n${text}`);
  },
};

export interface Config {
  db: Pool;
  secret: string;
  bcryptCost: number;
  mailer?: Mailer;
  timeZone?: string;
  now?: () => Date;
}

// State of one request: the signed in user, the cookies to send and the effective method (after `_method`).
interface Ctx {
  cookies: Map<string, string>;
  setCookies: string[];
  method: string;
  sessionId: number;
  user: User | null;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

type Form = Record<string, string | string[] | undefined>;
type Req = FastifyRequest;
type Handler = (req: Req, reply: FastifyReply) => Promise<unknown> | unknown;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? "" : value ?? "");
const formValue = (req: Req, name: string) => first(((req.body as Form) ?? {})[name]);
const queryValue = (req: Req, name: string) => first(((req.query as Form) ?? {})[name]);

const plainError = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).header("content-type", "text/plain; charset=utf-8").header("x-content-type-options", "nosniff").send(message + "\n");

const notFound = (reply: FastifyReply) => plainError(reply, 404, "404 page not found");

function remoteIP(req: Req): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function absoluteURL(req: Req, path: string): string {
  return "http://" + (req.headers.host ?? "") + path;
}

export function buildServer(config: Config): FastifyInstance & { passwordResetToken(u: User): string } {
  const { db, secret, bcryptCost } = config;
  const mailer = config.mailer ?? logMailer;
  const timeZone = config.timeZone ?? "America/Sao_Paulo";
  const now = config.now ?? (() => new Date());
  const limiter = new RateLimiter(now);
  // dummy is checked when the e-mail does not exist, so both cases take the same time.
  const dummy = { passwordDigest: m.hashPassword("dummy-password", bcryptCost) };
  const today = () => todayIn(now(), timeZone);

  const app = Fastify({ logger: false, return503OnClosing: false });
  app.register(formbody);
  app.register(fastifyStatic, { root: join(__dirname, "..", "..", "static"), wildcard: false, index: false });

  // Cookies

  const setCookie = (req: Req, name: string, value: string, maxAge: number) => req.ctx.setCookies.push(cookieHeader(name, value, maxAge));
  const deleteCookie = (req: Req, name: string) => setCookie(req, name, "", -1);
  const readSigned = (req: Req, name: string) => {
    const value = req.ctx.cookies.get(name);
    return value === undefined ? null : verify(secret, name, value);
  };

  // Rails-like request pipeline: method override, CSRF check and session.

  app.decorateRequest("ctx", null as unknown as Ctx);
  app.addHook("onRequest", async (req) => {
    req.ctx = { cookies: parseCookies(req.headers.cookie), setCookies: [], method: req.method, sessionId: 0, user: null };
  });
  app.addHook("onSend", async (req, reply) => {
    if (req.ctx?.setCookies.length) reply.header("set-cookie", req.ctx.setCookies);
  });
  app.addHook("preHandler", async (req, reply) => {
    const url = req.url;
    if (url.startsWith("/css/") || url.startsWith("/js/") || url.startsWith("/icon.") || url === "/up") return;
    if (req.method === "POST") {
      const method = formValue(req, "_method").toUpperCase();
      if (method === "PUT" || method === "PATCH" || method === "DELETE") req.ctx.method = method;
      const cookie = req.ctx.cookies.get(csrfCookie) ?? "";
      if (cookie === "" || !safeEqual(cookie, formValue(req, "authenticity_token"))) {
        return plainError(reply, 422, "Unprocessable Content");
      }
    }
    await resumeSession(req);
  });

  // Authentication like Rails 8's generator: a signed "session_id" cookie pointing to a row in `sessions`.

  async function resumeSession(req: Req) {
    const value = readSigned(req, sessionCookie);
    if (value === null || !/^\d+$/.test(value)) return;
    const { rows } = await db.query(
      `SELECT u.id, u.email_address, u.password_digest FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [Number(value)],
    );
    if (rows[0]) {
      req.ctx.sessionId = Number(value);
      req.ctx.user = { id: rows[0].id, emailAddress: rows[0].email_address, passwordDigest: rows[0].password_digest };
    }
  }

  async function startNewSessionFor(req: Req, user: User) {
    const userAgent = (req.headers["user-agent"] ?? "").slice(0, 255);
    const { rows } = await db.query(
      `INSERT INTO sessions (user_id, user_agent, ip_address, created_at, updated_at) VALUES ($1, $2, $3, now(), now()) RETURNING id`,
      [user.id, userAgent, remoteIP(req)],
    );
    setCookie(req, sessionCookie, sign(secret, sessionCookie, String(rows[0].id)), permanentAge);
  }

  async function terminateSession(req: Req) {
    if (req.ctx.user) await db.query("DELETE FROM sessions WHERE id = $1", [req.ctx.sessionId]);
    deleteCookie(req, sessionCookie);
  }

  // requireAuthentication redirects guests to the login and remembers the page they asked for.
  const auth = (next: Handler): Handler => (req, reply) => {
    if (!req.ctx.user) {
      setCookie(req, returnToCookie, sign(secret, returnToCookie, absoluteURL(req, req.raw.url ?? "/")), 0);
      return reply.redirect("/session/new", 302);
    }
    return next(req, reply);
  };

  function afterAuthenticationURL(req: Req): string {
    const url = readSigned(req, returnToCookie);
    if (url !== null) {
      deleteCookie(req, returnToCookie);
      return url;
    }
    return absoluteURL(req, "/");
  }

  // CSRF token kept in a cookie and repeated in every form (double submit).
  function csrfToken(req: Req): string {
    const existing = req.ctx.cookies.get(csrfCookie);
    if (existing) return existing;
    const token = newCSRFToken();
    req.ctx.cookies.set(csrfCookie, token);
    setCookie(req, csrfCookie, token, 0);
    return token;
  }

  // Flash messages survive one redirect, like Rails' flash.
  function takeFlash(req: Req): Flash {
    const value = readSigned(req, flashCookie);
    if (value === null) return {};
    deleteCookie(req, flashCookie);
    try {
      return JSON.parse(value) as Flash;
    } catch {
      return {};
    }
  }

  function redirectWith(req: Req, reply: FastifyReply, url: string, status: number, flash: Flash) {
    setCookie(req, flashCookie, sign(secret, flashCookie, JSON.stringify(flash)), 0);
    return reply.redirect(url, status);
  }

  // render puts a page inside the layout. content receives the CSRF token.
  function render(req: Req, reply: FastifyReply, title: string, status: number, content: (csrf: string) => string, nav?: string) {
    const flash = takeFlash(req);
    const csrf = csrfToken(req);
    const html = views.layout(title, content(csrf), { user: req.ctx.user, notice: flash.notice ?? "", alert: flash.alert ?? "", csrf, nav });
    return reply.code(status).type("text/html; charset=utf-8").send(html);
  }

  // Compact JSON like jbuilder.
  const sendJSON = (reply: FastifyReply, value: unknown) => reply.type("application/json; charset=utf-8").send(JSON.stringify(value));

  const rateLimit = (name: string, backTo: string, next: Handler): Handler => (req, reply) => {
    if (!limiter.allow(name + ":" + remoteIP(req), 10, 3 * 60 * 1000)) {
      return redirectWith(req, reply, backTo, 302, { alert: "Tente novamente mais tarde." });
    }
    return next(req, reply);
  };

  // Sessions

  const newSession: Handler = (req, reply) =>
    render(req, reply, "Entrar", 200, (csrf) => views.sessionsNew(queryValue(req, "email_address"), csrf));

  const createSession: Handler = async (req, reply) => {
    const user = await m.findUserByEmail(db, formValue(req, "email_address"));
    // Burn the same time as a real check to avoid user enumeration by timing.
    if (!user) m.checkPassword(dummy, "x");
    if (!user || !m.checkPassword(user, formValue(req, "password"))) {
      return redirectWith(req, reply, "/session/new", 302, { alert: "E-mail ou senha inválidos." });
    }
    await startNewSessionFor(req, user);
    return reply.redirect(afterAuthenticationURL(req), 302);
  };

  const destroySession: Handler = async (req, reply) => {
    await terminateSession(req);
    return reply.redirect("/session/new", 303);
  };

  // Registrations

  const newRegistration: Handler = (req, reply) =>
    render(req, reply, "Criar conta", 200, (csrf) => views.registrationsNew("", undefined, csrf));

  const createRegistration: Handler = async (req, reply) => {
    const user: User = { id: 0, emailAddress: formValue(req, "user[email_address]"), passwordDigest: "" };
    const password = formValue(req, "user[password]");
    const confirmation = formValue(req, "user[password_confirmation]");
    const errs = await m.validateUser(db, user, password, confirmation, true);
    if (errs.length > 0) {
      return render(req, reply, "Criar conta", 422, (csrf) => views.registrationsNew(user.emailAddress, errs, csrf));
    }
    user.passwordDigest = m.hashPassword(password, bcryptCost);
    await m.createUser(db, user);
    await startNewSessionFor(req, user);
    return redirectWith(req, reply, "/", 302, { notice: "Conta criada." });
  };

  // Passwords: the reset token is signed, expires in 15 minutes and stops working once the password changes.

  function passwordResetToken(user: User): string {
    const expires = Math.floor(now().getTime() / 1000) + passwordResetMaxAge;
    const payload = `${user.id}:${user.passwordDigest.slice(-10)}:${expires}`;
    return Buffer.from(payload).toString("base64url") + "." + hmac(secret, "password_reset:" + payload).toString("base64url");
  }

  async function findByPasswordResetToken(token: string): Promise<User | null> {
    const at = token.indexOf(".");
    if (at < 0) return null;
    const payload = Buffer.from(token.slice(0, at), "base64url").toString();
    if (!safeEqual(hmac(secret, "password_reset:" + payload).toString("base64url"), token.slice(at + 1))) return null;
    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    if (Math.floor(now().getTime() / 1000) > Number(parts[2])) return null;
    const user = await m.findUser(db, Number(parts[0]) || 0);
    if (!user || user.passwordDigest.slice(-10) !== parts[1]) return null;
    return user;
  }

  const invalidLink = { alert: "O link de redefinição é inválido ou expirou." };

  const newPassword: Handler = (req, reply) =>
    render(req, reply, "Recuperar senha", 200, (csrf) => views.passwordsNew(queryValue(req, "email_address"), csrf));

  const createPassword: Handler = async (req, reply) => {
    const user = await m.findUserByEmail(db, formValue(req, "email_address"));
    if (user) {
      const url = absoluteURL(req, "/passwords/" + passwordResetToken(user) + "/edit");
      const text = "Você pode redefinir sua senha em\n" + url + "\n\nEste link expira em 15 minutos.\n";
      try {
        await mailer.send(user.emailAddress, "Redefinição de senha", text);
      } catch (err) {
        console.error("mail error:", err);
      }
    }
    return redirectWith(req, reply, "/session/new", 302, {
      notice: "Se o e-mail estiver cadastrado, enviamos as instruções para redefinir a senha.",
    });
  };

  const editPassword: Handler = async (req, reply) => {
    const token = (req.params as { token: string }).token;
    if (!(await findByPasswordResetToken(token))) return redirectWith(req, reply, "/passwords/new", 302, invalidLink);
    return render(req, reply, "Nova senha", 200, (csrf) => views.passwordsEdit(token, csrf));
  };

  const updatePassword: Handler = async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const user = await findByPasswordResetToken(token);
    if (!user) return redirectWith(req, reply, "/passwords/new", 302, invalidLink);
    const password = formValue(req, "password");
    const confirmation = formValue(req, "password_confirmation");
    const errs = await m.validateUser(db, user, password, confirmation, true);
    if (errs.length > 0) {
      return redirectWith(req, reply, "/passwords/" + token + "/edit", 302, { alert: "As senhas não conferem ou têm menos de 6 caracteres." });
    }
    user.passwordDigest = m.hashPassword(password, bcryptCost);
    await m.updatePassword(db, user);
    await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    return redirectWith(req, reply, "/session/new", 302, { notice: "Senha redefinida." });
  };

  // Current accounts (entries)

  const asJSON = (req: Req, e: Entry) => ({
    id: e.id, cash_account_id: e.cashAccountId, cost_id: e.costId, date_ocurrence: e.date, price: decimalText(e.priceCents),
    historic: e.historic, user_id: e.userId, type_launche: e.typeLaunche, url: absoluteURL(req, `/current_accounts/${e.id}.json`),
  });

  const listEntries: Handler = async (req, reply) => {
    const user = req.ctx.user!;
    const day = parseDate(queryValue(req, "date"));
    const rawPage = queryValue(req, "page");
    const page = Math.max(/^[+-]?\d+$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) ? Number(rawPage) : 0, 1);
    let entries = await m.listEntries(db, user.id, day, PER_PAGE + 1, (page - 1) * PER_PAGE);
    const nextPage = entries.length > PER_PAGE;
    if (nextPage) entries = entries.slice(0, PER_PAGE);
    if (req.url.split("?")[0].endsWith(".json")) return sendJSON(reply, entries.map((e) => asJSON(req, e)));
    const total = await m.balance(db, user.id, day);
    return render(req, reply, "Conta Corrente", 200, () => views.currentAccountsIndex({
      entries, balance: total, dateLabel: day ? dateBR(day) : "", dateValue: day ?? "", dateParam: day ? `date=${day}&` : "", page, nextPage,
    }), "index");
  };

  // entryFromPath loads the signed in user's entry; other users' entries are "not found".
  async function entryFromPath(req: Req, reply: FastifyReply): Promise<{ entry: Entry; isJSON: boolean } | null> {
    const raw = (req.params as { id: string }).id;
    const isJSON = raw.endsWith(".json");
    const idText = isJSON ? raw.slice(0, -5) : raw;
    if (!/^[+-]?\d+$/.test(idText) || !Number.isSafeInteger(Number(idText))) {
      notFound(reply);
      return null;
    }
    const entry = await m.findEntry(db, req.ctx.user!.id, Number(idText));
    if (!entry) {
      notFound(reply);
      return null;
    }
    return { entry, isJSON };
  }

  const showEntry: Handler = async (req, reply) => {
    const found = await entryFromPath(req, reply);
    if (!found) return reply;
    if (found.isJSON) return sendJSON(reply, asJSON(req, found.entry));
    return render(req, reply, "Lançamento", 200, (csrf) => views.currentAccountsShow(found.entry, csrf));
  };

  const renderForm = (req: Req, reply: FastifyReply, edit: boolean, e: Entry, errs: string[] | undefined, status: number) => {
    const title = edit ? "Editar lançamento" : "Novo lançamento";
    return render(req, reply, title, status, (csrf) => views.currentAccountsForm(title, e, errs, csrf));
  };

  const newEntry: Handler = (req, reply) =>
    renderForm(req, reply, false, new Entry({ date: today(), typeLaunche: m.Debit, cashAccountId: m.Unset, costId: m.Unset }), undefined, 200);

  const editEntry: Handler = async (req, reply) => {
    const found = await entryFromPath(req, reply);
    if (!found) return reply;
    return renderForm(req, reply, true, found.entry, undefined, 200);
  };

  // assign copies the form fields into the entry and returns the validation messages.
  // Like Rails strong parameters, a field missing from the form keeps its current value.
  function assign(e: Entry, req: Req): string[] {
    const body = (req.body as Form) ?? {};
    const has = (name: string) => body[`current_account[${name}]`] !== undefined;
    const field = (name: string) => formValue(req, `current_account[${name}]`);
    const integer = (name: string) => {
      const value = field(name).trim();
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return m.Unset;
      return Number(value);
    };
    if (has("cash_account_id")) e.cashAccountId = integer("cash_account_id");
    if (has("cost_id")) e.costId = integer("cost_id");
    if (has("type_launche")) {
      const type = field("type_launche");
      e.typeLaunche = type === "debito" ? m.Debit : type === "credito" ? m.Credit : 0;
    }
    if (has("date_ocurrence")) e.date = parseDate(field("date_ocurrence")) ?? "";
    if (has("price")) {
      e.priceText = field("price").trim();
      e.priceSet = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(e.priceText);
      if (e.priceSet) {
        const price = Number(e.priceText);
        e.priceCents = Math.trunc(price * 100 + 0.5 * (price < 0 ? -1 : 1));
      }
    }
    if (has("historic")) {
      const historic = field("historic");
      e.historic = historic !== "" ? historic : null;
    }
    return e.validate();
  }

  const createEntry: Handler = async (req, reply) => {
    const e = new Entry({ userId: req.ctx.user!.id });
    const errs = assign(e, req);
    if (errs.length > 0) return renderForm(req, reply, false, e, errs, 422);
    await m.saveEntry(db, e);
    return redirectWith(req, reply, "/current_accounts", 302, { notice: "Lançamento cadastrado." });
  };

  const updateEntry: Handler = async (req, reply) => {
    const found = await entryFromPath(req, reply);
    if (!found) return reply;
    const e = found.entry;
    const errs = assign(e, req);
    if (errs.length > 0) return renderForm(req, reply, true, e, errs, 422);
    await m.saveEntry(db, e);
    return redirectWith(req, reply, `/current_accounts/${e.id}`, 302, { notice: "Lançamento atualizado." });
  };

  const destroyEntry: Handler = async (req, reply) => {
    const found = await entryFromPath(req, reply);
    if (!found) return reply;
    await m.deleteEntry(db, found.entry);
    return redirectWith(req, reply, "/current_accounts", 303, { notice: "Lançamento removido." });
  };

  // Dashboard

  function parseMonth(value: string): { year: number; month: number } {
    const match = /^(\d{4})-(\d{1,2})$/.exec(value);
    if (match) {
      const month = Number(match[2]);
      if (month >= 1 && month <= 12) return { year: Number(match[1]), month };
    }
    const t = today();
    return { year: Number(t.slice(0, 4)), month: Number(t.slice(5, 7)) };
  }

  // monthParam formats "YYYY-MM", moving to the previous or next year when month is 0 or 13.
  const monthParam = (year: number, month: number) => {
    const index = year * 12 + month - 1;
    return String(Math.floor(index / 12)).padStart(4, "0") + "-" + String((index % 12) + 1).padStart(2, "0");
  };

  const showDashboard: Handler = async (req, reply) => {
    const { year, month } = parseMonth(queryValue(req, "month"));
    const summary = await m.summarizeMonth(db, req.ctx.user!.id, year, month);
    const label = months[month - 1] + " de " + year;
    return render(req, reply, "Dashboard", 200, () => views.dashboardsShow({
      monthLabel: label[0].toUpperCase() + label.slice(1), today: today(),
      previousMonth: monthParam(year, month - 1), nextMonth: monthParam(year, month + 1), summary,
    }), "dashboard");
  };

  // Routes. Forms POST with `_method`, so each POST route dispatches on the effective method.

  const byMethod = (handlers: Record<string, Handler>): Handler => (req, reply) => {
    const handler = handlers[req.ctx.method];
    return handler ? handler(req, reply) : plainError(reply, 405, "Method Not Allowed");
  };

  app.get("/up", (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(`<!DOCTYPE html><html><body style="background-color: green"></body></html>`));

  app.get("/session/new", newSession);
  app.post("/session", byMethod({ POST: rateLimit("sessions", "/session/new", createSession), DELETE: auth(destroySession) }));
  app.delete("/session", auth(destroySession));
  app.get("/registration/new", newRegistration);
  app.post("/registration", byMethod({ POST: rateLimit("registrations", "/registration/new", createRegistration) }));
  app.get("/passwords/new", newPassword);
  app.post("/passwords", byMethod({ POST: rateLimit("passwords", "/passwords/new", createPassword) }));
  app.get("/passwords/:token/edit", editPassword);
  app.post("/passwords/:token", byMethod({ PUT: updatePassword, PATCH: updatePassword }));
  app.put("/passwords/:token", updatePassword);
  app.patch("/passwords/:token", updatePassword);

  app.get("/", auth(listEntries));
  app.get("/current_accounts", auth(listEntries));
  app.get("/current_accounts.json", auth(listEntries));
  app.post("/current_accounts", byMethod({ POST: auth(createEntry) }));
  app.get("/current_accounts/new", auth(newEntry));
  app.get("/current_accounts/:id", auth(showEntry));
  app.get("/current_accounts/:id/edit", auth(editEntry));
  app.post("/current_accounts/:id", byMethod({ PUT: auth(updateEntry), PATCH: auth(updateEntry), DELETE: auth(destroyEntry) }));
  app.put("/current_accounts/:id", auth(updateEntry));
  app.patch("/current_accounts/:id", auth(updateEntry));
  app.delete("/current_accounts/:id", auth(destroyEntry));
  app.get("/dashboard", auth(showDashboard));

  // Legacy daily balance search, now a filter on the listing.
  app.get("/search_account", (req, reply) => reply.redirect("/current_accounts?date=" + queryValue(req, "date_calendar_now"), 301));

  app.setNotFoundHandler((_req, reply) => notFound(reply));
  app.setErrorHandler((err, _req, reply) => {
    console.error("error:", err);
    plainError(reply, 500, "Internal Server Error");
  });

  return Object.assign(app, { passwordResetToken });
}
