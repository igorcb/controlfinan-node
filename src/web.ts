// Signed cookies, CSRF token, flash and the rate limiter, like the Rails app.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sessionCookie = "session_id";
export const csrfCookie = "_csrf_token";
export const flashCookie = "_flash";
export const returnToCookie = "return_to";
export const permanentAge = 20 * 365 * 24 * 60 * 60; // cookies.permanent

export function hmac(secret: string, text: string): Buffer {
  return createHmac("sha256", secret).update(text).digest();
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

// sign and verify protect cookie values with HMAC-SHA256 ("value--signature").
export function sign(secret: string, purpose: string, value: string): string {
  return b64(value) + "--" + b64(hmac(secret, purpose + ":" + value));
}

export function verify(secret: string, purpose: string, signed: string): string | null {
  const at = signed.indexOf("--");
  if (at < 0) return null;
  const raw = Buffer.from(signed.slice(0, at), "base64url").toString();
  return safeEqual(sign(secret, purpose, raw), signed) ? raw : null;
}

// cookieHeader writes a Set-Cookie value like Go's http.SetCookie (maxAge 0 = browser session, < 0 = delete).
export function cookieHeader(name: string, value: string, maxAge: number): string {
  let header = `${name}=${value}; Path=/`;
  if (maxAge > 0) header += `; Max-Age=${maxAge}`;
  else if (maxAge < 0) header += "; Max-Age=0";
  return header + "; HttpOnly; SameSite=Lax";
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(at + 1).trim().replace(/^"(.*)"$/, "$1"));
  }
  return cookies;
}

export function newCSRFToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface Flash {
  notice?: string;
  alert?: string;
}

// RateLimiter works like Rails `rate_limit to: 10, within: 3.minutes`: a counter per action and IP.
export class RateLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();

  constructor(private now: () => Date) {}

  allow(key: string, to: number, withinMs: number): boolean {
    const now = this.now().getTime();
    let entry = this.entries.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + withinMs };
      this.entries.set(key, entry);
    }
    entry.count++;
    return entry.count <= to;
  }
}
