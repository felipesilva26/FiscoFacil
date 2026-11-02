import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Data de hoje em Brasília (AAAA-MM-DD). O relógio é injetável para os testes. */
export function todayISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

const toUtc = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export const addDaysISO = (s: string, n: number): string =>
  new Date(toUtc(s) + n * 86_400_000).toISOString().slice(0, 10);

/** Quantos dias de `b` até `a` (positivo se `a` é depois de `b`). */
export const diffDays = (a: string, b: string): number => Math.round((toUtc(a) - toUtc(b)) / 86_400_000);

export const isISODate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysISO(s, 0) === s;

export const toCents = (reais: number): number => Math.round(reais * 100);
export const fromCents = (c: number): number => c / 100;

export const brl = (reais: number): string =>
  reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtDateBR = (iso: string): string => iso.split('-').reverse().join('/');
