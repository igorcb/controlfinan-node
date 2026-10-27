// Money is kept in integer cents to avoid floating point errors.

function pad2(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

// Currency formats like Rails number_to_currency in pt-BR: "R$ 1.234,50"; negatives as "-R$ 1.234,50".
export function currency(cents: number): string {
  let sign = "";
  if (cents < 0) {
    sign = "-";
    cents = -cents;
  }
  const units = String(Math.floor(cents / 100));
  let grouped = "";
  for (let i = 0; i < units.length; i++) {
    if (i > 0 && (units.length - i) % 3 === 0) grouped += ".";
    grouped += units[i];
  }
  return sign + "R$ " + grouped + "," + pad2(cents % 100);
}

// amountClass is the color of an amount: red when negative, green otherwise.
export function amountClass(cents: number): string {
  return cents < 0 ? "text-red-700" : "text-emerald-700";
}

// decimalText prints cents like Ruby's BigDecimal#to_s: 15000 -> "150.0", 1250 -> "12.5", 5 -> "0.05".
export function decimalText(cents: number): string {
  let sign = "";
  if (cents < 0) {
    sign = "-";
    cents = -cents;
  }
  const fraction = pad2(cents % 100).replace(/0+$/, "") || "0";
  return sign + Math.floor(cents / 100) + "." + fraction;
}

// parseCents reads a Postgres numeric as text ("-12.5", "150.00", "0") into cents.
export function parseCents(text: string): number {
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  const [units, fraction = ""] = text.split(".");
  const total = (parseInt(units, 10) || 0) * 100 + (parseInt((fraction + "00").slice(0, 2), 10) || 0);
  return negative ? -total : total;
}

// Dates are "YYYY-MM-DD" strings, like the SQL date type.

// parseDate accepts only a valid "YYYY-MM-DD", like Go's time.Parse.
export function parseDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return value;
}

export function dateBR(iso: string): string {
  return iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4);
}

export function dayMonth(iso: string): string {
  return iso.slice(8, 10) + "/" + iso.slice(5, 7);
}

// todayIn returns the current date ("YYYY-MM-DD") in the given time zone.
export function todayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function escapeHTML(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
