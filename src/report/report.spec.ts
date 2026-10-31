import { daysLeft, yearStart } from './report.service';

describe('relatórios', () => {
  it('daysLeft: estoque / ritmo diário', () => {
    expect(daysLeft(10, 30, 30)).toBe(10);   // 1 un/dia
    expect(daysLeft(3, 60, 30)).toBe(1.5);   // 2 un/dia
    expect(daysLeft(5, 0, 30)).toBeNull();   // sem vendas: sem previsão
  });
  it('yearStart: 1º de janeiro 00:00 em Fortaleza (03:00 UTC)', () => {
    expect(yearStart(2026).toISOString()).toBe('2026-01-01T03:00:00.000Z');
  });
});
