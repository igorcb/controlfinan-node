// HTML with the same result as the Rails app (ported from the Go templates, same whitespace).
import { amountClass, currency, escapeHTML as h } from "../format";
import { CashAccounts, Costs, Entry, MonthSummary, Option, Row, User } from "../models";

export interface LayoutData {
  user: User | null;
  notice: string;
  alert: string;
  csrf: string;
  nav?: string;
}

const when = (condition: unknown, text: string, otherwise = ""): string => (condition ? text : otherwise);

export function layout(title: string, content: string, d: LayoutData): string {
  const userNav = d.user
    ? `
          <div class="flex items-center gap-4 text-sm">
            <a class="link hidden sm:inline" href="/current_accounts">Conta Corrente</a>
            <a class="link hidden sm:inline" href="/dashboard">Dashboard</a>
            <span class="hidden text-slate-500 md:inline">${h(d.user.emailAddress)}</span>
            <form class="button_to" method="post" action="/session"><input type="hidden" name="_method" value="delete" autocomplete="off"><button class="link py-1" type="submit">Sair</button><input type="hidden" name="authenticity_token" value="${h(d.csrf)}" autocomplete="off"></form>
          </div>`
    : "";
  const bottomNav = d.user
    ? `
      <nav class="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] sm:hidden">
        <div class="grid grid-cols-3 items-center text-xs font-medium text-slate-600">
          <a class="flex flex-col items-center gap-1 py-2 ${when(d.nav === "index", "text-emerald-700")}" href="/current_accounts">
            <svg class="size-6" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm0 5.25h.007v.008H3.75V12Zm0 5.25h.007v.008H3.75v-.008Z"/></svg>
            Lançamentos
          </a>
          <a class="mx-auto -mt-6 flex size-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg ring-4 ring-white" aria-label="Novo lançamento" href="/current_accounts/new">
            <svg class="size-7" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          </a>
          <a class="flex flex-col items-center gap-1 py-2 ${when(d.nav === "dashboard", "text-emerald-700")}" href="/dashboard">
            <svg class="size-6" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"/></svg>
            Dashboard
          </a>
        </div>
      </nav>`
    : "";
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="application-name" content="ControlFinan">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#047857">
    <meta name="csrf-token" content="${h(d.csrf)}">

    <link rel="icon" href="/icon.png" type="image/png">
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/icon.png">

    <link rel="stylesheet" href="/css/app.css">
    <script src="/js/app.js" defer></script>
  </head>

  <body class="min-h-screen bg-slate-50 text-slate-900">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-white">
      <nav class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <a class="text-lg font-semibold text-emerald-700" href="/">ControlFinan</a>${userNav}
      </nav>
    </header>

    <main class="mx-auto max-w-5xl px-4 py-6 ${when(d.user, "pb-28 sm:pb-6")}">${when(d.notice, `
        <p class="mb-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">${h(d.notice)}</p>`)}${when(d.alert, `
        <p class="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">${h(d.alert)}</p>`)}

      ${content}
    </main>${bottomNav}
  </body>
</html>
`;
}

function errorsPartial(errors: string[] | undefined): string {
  if (!errors || errors.length === 0) return "\n";
  return `
    <div class="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
      <ul class="list-inside list-disc">
        ${errors.map((e) => `<li>${h(e)}</li>`).join("")}
      </ul>
    </div>
`;
}

const tokenField = (csrf: string) => `<input type="hidden" name="authenticity_token" value="${h(csrf)}" autocomplete="off">`;

// Sessions, registrations and passwords

export function sessionsNew(emailAddress: string, csrf: string): string {
  return `
<div class="mx-auto max-w-sm">
  <h1 class="mb-6 text-2xl font-semibold">Entrar</h1>

  <form class="card space-y-4" action="/session" accept-charset="UTF-8" method="post">${tokenField(csrf)}
    <div>
      <label class="label" for="email_address">E-mail</label>
      <input required="required" autofocus="autofocus" autocomplete="username" value="${h(emailAddress)}" class="input" type="email" name="email_address" id="email_address">
    </div>
    <div>
      <label class="label" for="password">Senha</label>
      <input required="required" autocomplete="current-password" maxlength="72" class="input" type="password" name="password" id="password">
    </div>
    <input type="submit" value="Entrar" class="btn-primary w-full">
  </form>

  <div class="mt-4 flex justify-between text-sm">
    <a class="link" href="/registration/new">Criar conta</a>
    <a class="link" href="/passwords/new">Esqueceu a senha?</a>
  </div>
</div>
`;
}

export function registrationsNew(emailAddress: string, errors: string[] | undefined, csrf: string): string {
  return `
<div class="mx-auto max-w-sm">
  <h1 class="mb-6 text-2xl font-semibold">Criar conta</h1>

  <form class="card space-y-4" action="/registration" accept-charset="UTF-8" method="post">${tokenField(csrf)}
    ${errorsPartial(errors)}

    <div>
      <label class="label" for="user_email_address">E-mail</label>
      <input required="required" autofocus="autofocus" autocomplete="username" class="input" type="email" value="${h(emailAddress)}" name="user[email_address]" id="user_email_address">
    </div>
    <div>
      <label class="label" for="user_password">Senha</label>
      <input required="required" autocomplete="new-password" minlength="6" maxlength="72" class="input" type="password" name="user[password]" id="user_password">
    </div>
    <div>
      <label class="label" for="user_password_confirmation">Confirmação da senha</label>
      <input required="required" autocomplete="new-password" maxlength="72" class="input" type="password" name="user[password_confirmation]" id="user_password_confirmation">
    </div>
    <input type="submit" value="Criar conta" class="btn-primary w-full">
  </form>

  <p class="mt-4 text-sm">
    Já tem conta? <a class="link" href="/session/new">Entrar</a>
  </p>
</div>
`;
}

export function passwordsNew(emailAddress: string, csrf: string): string {
  return `
<div class="mx-auto max-w-sm">
  <h1 class="mb-6 text-2xl font-semibold">Esqueceu a senha?</h1>

  <form class="card space-y-4" action="/passwords" accept-charset="UTF-8" method="post">${tokenField(csrf)}
    <div>
      <label class="label" for="email_address">E-mail</label>
      <input required="required" autofocus="autofocus" autocomplete="username" value="${h(emailAddress)}" class="input" type="email" name="email_address" id="email_address">
    </div>
    <input type="submit" value="Enviar instruções" class="btn-primary w-full">
  </form>

  <p class="mt-4 text-sm"><a class="link" href="/session/new">Voltar para o login</a></p>
</div>
`;
}

export function passwordsEdit(token: string, csrf: string): string {
  return `
<div class="mx-auto max-w-sm">
  <h1 class="mb-6 text-2xl font-semibold">Defina sua nova senha</h1>

  <form class="card space-y-4" action="/passwords/${h(token)}" accept-charset="UTF-8" method="post"><input type="hidden" name="_method" value="put" autocomplete="off">${tokenField(csrf)}
    <div>
      <label class="label" for="password">Nova senha</label>
      <input required="required" autocomplete="new-password" minlength="6" maxlength="72" class="input" type="password" name="password" id="password">
    </div>
    <div>
      <label class="label" for="password_confirmation">Repita a nova senha</label>
      <input required="required" autocomplete="new-password" maxlength="72" class="input" type="password" name="password_confirmation" id="password_confirmation">
    </div>
    <input type="submit" value="Salvar" class="btn-primary w-full">
  </form>
</div>
`;
}

// Current accounts (entries)

export interface IndexData {
  entries: Entry[];
  balance: number;
  dateLabel: string;
  dateValue: string;
  dateParam: string;
  page: number;
  nextPage: boolean;
}

const creditClass = (e: Entry) => (e.isCredit ? "text-emerald-700" : "text-red-700");

export function currentAccountsIndex(d: IndexData): string {
  let list: string;
  if (d.entries.length === 0) {
    list = `
  <p class="card text-center text-sm text-slate-500">Nenhum lançamento encontrado.</p>
`;
  } else {
    const items = d.entries
      .map(
        (e) => `
      <li>
        <a class="flex items-center justify-between gap-3 px-4 py-3 active:bg-slate-50" href="/current_accounts/${e.id}">
          <div class="min-w-0">
            <p class="truncate font-medium">${h(e.nameCost)}</p>
            <p class="truncate text-xs text-slate-500">
              ${e.dayMonth} · ${h(e.nameAccount)}${when(e.historicText, ` · ${h(e.historicText)}`)}
            </p>
          </div>
          <span class="shrink-0 font-semibold ${creditClass(e)}">
            ${currency(e.signedCents)}
          </span>
        </a>
      </li>
    `,
      )
      .join("");
    const rows = d.entries
      .map(
        (e) => `
          <tr id="current_account_${e.id}" class="hover:bg-slate-50">
            <td class="whitespace-nowrap px-4 py-3">${e.dateBR}</td>
            <td class="px-4 py-3">${h(e.nameAccount)}</td>
            <td class="px-4 py-3">${h(e.nameCost)}</td>
            <td class="px-4 py-3 text-slate-600">${h(e.historicText)}</td>
            <td class="whitespace-nowrap px-4 py-3 text-right font-medium ${creditClass(e)}">
              ${currency(e.signedCents)}
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-right">
              <a class="link" href="/current_accounts/${e.id}">Ver</a>
              <a class="link ml-2" href="/current_accounts/${e.id}/edit">Editar</a>
            </td>
          </tr>
        `,
      )
      .join("");
    list = `
  <ul class="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm sm:hidden">
    ${items}
  </ul>

  <div class="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm sm:block">
    <table class="min-w-full divide-y divide-slate-200 text-sm">
      <thead class="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
        <tr>
          <th class="px-4 py-3">Data</th>
          <th class="px-4 py-3">Conta</th>
          <th class="px-4 py-3">Categoria</th>
          <th class="px-4 py-3">Histórico</th>
          <th class="px-4 py-3 text-right">Valor</th>
          <th class="px-4 py-3"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        ${rows}
      </tbody>
    </table>
  </div>
`;
  }
  return `
<div class="mb-4 flex items-end justify-between gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Conta Corrente</h1>
    <p class="mt-1 text-sm text-slate-600">${d.dateLabel ? `Saldo do dia ${d.dateLabel}` : "Saldo total"}</p>
    <p class="text-2xl font-bold ${amountClass(d.balance)}">${currency(d.balance)}</p>
  </div>

  <a class="btn-primary hidden sm:inline-flex" href="/current_accounts/new">Novo lançamento</a>
</div>

<form class="mb-4 flex items-end gap-2" action="/current_accounts" accept-charset="UTF-8" method="get">
  <div class="min-w-0 flex-1 sm:flex-none">
    <label class="label" for="date">Consultar saldo do dia</label>
    <input class="input" type="date" value="${d.dateValue}" name="date" id="date">
  </div>
  <input type="submit" value="Consultar" class="btn-secondary">
  ${when(d.dateLabel, `<a class="btn-secondary" href="/current_accounts">Limpar</a>`)}
</form>

${list}

<nav class="mt-4 flex justify-between gap-3">
  ${when(d.page > 1, `<a class="btn-secondary" href="/current_accounts?${d.dateParam}page=${d.page - 1}">← Mais recentes</a>`)}
  ${when(d.nextPage, `<a class="btn-secondary ml-auto" href="/current_accounts?${d.dateParam}page=${d.page + 1}">Mais antigos →</a>`)}
</nav>
`;
}

export function currentAccountsShow(e: Entry, csrf: string): string {
  return `
<h1 class="mb-6 text-2xl font-semibold">Lançamento</h1>

<div class="card">
  <dl class="grid gap-4 text-sm sm:grid-cols-2">
    <div>
      <dt class="text-slate-500">Data</dt>
      <dd class="font-medium">${e.dateBR}</dd>
    </div>
    <div>
      <dt class="text-slate-500">Tipo</dt>
      <dd class="font-medium">${e.typeName}</dd>
    </div>
    <div>
      <dt class="text-slate-500">Conta</dt>
      <dd class="font-medium">${h(e.nameAccount)}</dd>
    </div>
    <div>
      <dt class="text-slate-500">Categoria</dt>
      <dd class="font-medium">${h(e.nameCost)}</dd>
    </div>
    <div>
      <dt class="text-slate-500">Valor</dt>
      <dd class="font-medium ${creditClass(e)}">${currency(e.signedCents)}</dd>
    </div>
    <div>
      <dt class="text-slate-500">Histórico</dt>
      <dd class="font-medium">${e.historicText ? h(e.historicText) : "—"}</dd>
    </div>
  </dl>

  <div class="mt-6 flex flex-wrap gap-3">
    <a class="btn-primary" href="/current_accounts/${e.id}/edit">Editar</a>
    <a class="btn-secondary" href="/current_accounts">Voltar</a>
    <form class="button_to" method="post" action="/current_accounts/${e.id}" data-confirm="Excluir este lançamento?"><input type="hidden" name="_method" value="delete" autocomplete="off"><button class="btn-danger" type="submit">Excluir</button>${tokenField(csrf)}</form>
  </div>
</div>
`;
}

function options(list: Option[], selected: number): string {
  return list.map((o) => `<option${when(o.id === selected, ` selected="selected"`)} value="${o.id}">${h(o.name)}</option>`).join("");
}

function form(e: Entry, errors: string[] | undefined, csrf: string): string {
  const path = e.persisted ? `/current_accounts/${e.id}` : "/current_accounts";
  return `
<form class="card space-y-4" action="${path}" accept-charset="UTF-8" method="post">${when(e.persisted, `<input type="hidden" name="_method" value="patch" autocomplete="off">`)}${tokenField(csrf)}
  ${errorsPartial(errors)}

  <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo">
    <label class="flex cursor-pointer items-center justify-center rounded-md border border-slate-300 py-3 font-medium text-slate-600 has-checked:border-red-600 has-checked:bg-red-600 has-checked:text-white">
      <input class="sr-only" type="radio" value="debito"${when(e.typeLaunche === -1, ` checked="checked"`)} name="current_account[type_launche]" id="current_account_type_launche_debito"> Débito
    </label>
    <label class="flex cursor-pointer items-center justify-center rounded-md border border-slate-300 py-3 font-medium text-slate-600 has-checked:border-emerald-600 has-checked:bg-emerald-600 has-checked:text-white">
      <input class="sr-only" type="radio" value="credito"${when(e.typeLaunche === 1, ` checked="checked"`)} name="current_account[type_launche]" id="current_account_type_launche_credito"> Crédito
    </label>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <label class="label" for="current_account_price">Valor</label>
      <input step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"${when(!e.persisted, ` autofocus="autofocus"`)} class="input text-lg font-semibold" type="number" value="${h(e.priceField)}" name="current_account[price]" id="current_account_price">
    </div>

    <div>
      <label class="label" for="current_account_date_ocurrence">Data</label>
      <input class="input" type="date" value="${e.date}" name="current_account[date_ocurrence]" id="current_account_date_ocurrence">
    </div>

    <div>
      <label class="label" for="current_account_cost_id">Categoria</label>
      <select class="input" name="current_account[cost_id]" id="current_account_cost_id">${when(e.costId === -1, `<option value="">Selecione</option>`)}
        ${options(Costs, e.costId)}
      </select>
    </div>

    <div>
      <label class="label" for="current_account_cash_account_id">Conta</label>
      <select class="input" name="current_account[cash_account_id]" id="current_account_cash_account_id">${when(e.cashAccountId === -1, `<option value="">Selecione</option>`)}
        ${options(CashAccounts, e.cashAccountId)}
      </select>
    </div>

    <div class="sm:col-span-2">
      <label class="label" for="current_account_historic">Histórico</label>
      <input class="input" type="text" value="${h(e.historicText)}" name="current_account[historic]" id="current_account_historic">
    </div>
  </div>

  <div class="flex flex-col-reverse gap-3 sm:flex-row">
    <a class="btn-secondary py-3 sm:py-2" href="${path}">Cancelar</a>
    <input type="submit" value="Salvar" class="btn-primary py-3 sm:order-first sm:py-2">
  </div>
</form>
`;
}

export function currentAccountsForm(title: string, e: Entry, errors: string[] | undefined, csrf: string): string {
  return `
<h1 class="mb-6 text-2xl font-semibold">${title}</h1>

${form(e, errors, csrf)}
`;
}

// Dashboard

function amounts(header: string, rows: Row[], totalLabel: string, total: number): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="px-2 py-2 sm:px-4">${h(r.label)}</td>
        <td class="px-2 py-2 sm:px-4 text-right ${amountClass(r.cents)}">${currency(r.cents)}</td>
      </tr>
    `,
    )
    .join("");
  return `
<table class="min-w-full divide-y divide-slate-200 text-sm">
  <thead class="text-left text-xs font-medium uppercase tracking-wide text-slate-500">
    <tr>
      <th class="px-2 py-2 sm:px-4">${header}</th>
      <th class="px-2 py-2 sm:px-4 text-right">Valor</th>
    </tr>
  </thead>
  <tbody class="divide-y divide-slate-100">
    ${body}
    ${when(rows.length === 0, `
      <tr><td colspan="2" class="px-4 py-4 text-center text-slate-500">Nenhum lançamento no período.</td></tr>
    `)}
  </tbody>
  <tfoot>
    <tr class="border-t-2 border-slate-200 font-semibold">
      <td class="px-2 py-2 sm:px-4">${totalLabel}</td>
      <td class="px-2 py-2 sm:px-4 text-right ${amountClass(total)}">${currency(total)}</td>
    </tr>
  </tfoot>
</table>
`;
}

export interface DashboardData {
  monthLabel: string;
  today: string;
  previousMonth: string;
  nextMonth: string;
  summary: MonthSummary;
}

export function dashboardsShow(d: DashboardData): string {
  const s = d.summary;
  return `
<div class="mb-6 flex flex-wrap items-end justify-between gap-4">
  <div>
    <h1 class="text-2xl font-semibold">Dashboard</h1>
    <div class="mt-2 flex items-center gap-3 text-sm">
      <a class="btn-secondary px-3 py-1" aria-label="Mês anterior" href="/dashboard?month=${d.previousMonth}">←</a>
      <span class="font-medium">${d.monthLabel}</span>
      <a class="btn-secondary px-3 py-1" aria-label="Próximo mês" href="/dashboard?month=${d.nextMonth}">→</a>
    </div>
  </div>

  <div class="flex w-full flex-wrap items-end gap-3 sm:w-auto">
    <form class="flex flex-1 items-end gap-2" action="/current_accounts" accept-charset="UTF-8" method="get">
      <div class="min-w-0 flex-1">
        <label class="label" for="date">Consultar saldo diário</label>
        <input class="input" type="date" value="${d.today}" name="date" id="date">
      </div>
      <input type="submit" value="Consultar" class="btn-secondary">
    </form>
    <a class="btn-primary hidden sm:inline-flex" href="/current_accounts/new">Novo lançamento</a>
  </div>
</div>

<div data-tabs class="card p-4 sm:p-6">
  <div role="tablist" class="-mx-2 mb-4 grid grid-cols-2 gap-2 border-b border-slate-200 px-2 pb-3 sm:mx-0 sm:flex sm:px-0">
    <button type="button" role="tab" data-tab
            class="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 aria-selected:bg-emerald-600 aria-selected:text-white">
      Saldo Diário
    </button>
    <button type="button" role="tab" data-tab
            class="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 aria-selected:bg-emerald-600 aria-selected:text-white">
      Saldo Mensal
    </button>
  </div>

  <div data-panel>
    ${amounts("Data", s.daily, "Total do mês", s.monthBalance)}
  </div>

  <div data-panel hidden>
    ${amounts("Item", s.monthly, "Saldo do mês", s.ridesNet)}
  </div>
</div>
`;
}
