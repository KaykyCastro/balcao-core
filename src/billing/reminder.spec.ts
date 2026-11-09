import { reminderDue, reminderText, waNumber } from './reminder.rules';

const DAY = 86_400_000;
const now = new Date('2026-11-10T12:00:00Z');
const inv = (daysLeft: number, sent: string[] = []) => ({ status: 'pending', dueDate: new Date(now.getTime() + daysLeft * DAY), reminders: sent.map((kind) => ({ kind })) });

describe('avisos da fatura (reminder.rules)', () => {
  it('cada momento tem o seu aviso, uma vez só', () => {
    expect(reminderDue(inv(15), now)).toBe('issued');
    expect(reminderDue(inv(15, ['issued']), now)).toBeNull();
    expect(reminderDue(inv(2.5, ['issued']), now)).toBe('d3');
    expect(reminderDue(inv(0.5, ['issued', 'd3']), now)).toBe('d1');
    expect(reminderDue(inv(-0.1, ['issued', 'd3', 'd1']), now)).toBe('overdue');
    expect(reminderDue(inv(-3, ['overdue']), now)).toBeNull();
  });

  it('rotina atrasada manda só o mais urgente e não volta atrás', () => {
    expect(reminderDue(inv(0.5), now)).toBe('d1');
    expect(reminderDue(inv(10, ['d1']), now)).toBeNull();
  });

  it('fatura paga ou cancelada não gera aviso', () => {
    expect(reminderDue({ ...inv(1), status: 'paid' }, now)).toBeNull();
    expect(reminderDue({ ...inv(-1), status: 'cancelled' }, now)).toBeNull();
  });

  it('com cartão: só avisa que saiu e, se vencer (cartão recusado), que bloqueou', () => {
    expect(reminderDue(inv(15), now, { autopay: true })).toBe('issued');
    expect(reminderDue(inv(2, ['issued']), now, { autopay: true })).toBeNull();
    expect(reminderDue(inv(0.5, ['issued']), now, { autopay: true })).toBeNull();
    expect(reminderDue(inv(-0.1, ['issued']), now, { autopay: true })).toBe('overdue');
  });

  it('textos dizem valor, vencimento, link e o que acontece', () => {
    const t = reminderText('d1', { name: 'Ana Souza', amountCents: 4000, dueDate: new Date('2026-11-11T03:05:00Z'), link: 'https://balcao.app/app/pagamento?fatura=1' });
    expect(t.subject).toBe('Sua fatura do Balcão vence amanhã (R$ 40,00)');
    expect(t.text).toContain('11/11/2026');
    expect(t.text).toContain('https://balcao.app/app/pagamento?fatura=1');
    expect(t.text).toContain('bloqueado');
    const a = reminderText('issued', { name: 'Ana', amountCents: 1990, dueDate: new Date('2026-11-16T03:05:00Z'), link: 'x', autopay: { chargeOn: new Date('2026-11-02T15:00:00Z') } });
    expect(a.text).toContain('cobrada no cartão');
    expect(a.short).toContain('cartão');
  });

  it('número do WhatsApp com 55 + DDD', () => {
    expect(waNumber('(81) 99876-5432')).toBe('5581998765432');
    expect(waNumber('+55 81 3333-4444')).toBe('558133334444');
    expect(waNumber('5581998765432')).toBe('5581998765432');
    expect(waNumber('123')).toBeNull();
    expect(waNumber('(01) 99999-9999')).toBeNull();
  });
});
