import { canMove, daysLeft, dueDate, OPEN_ORDER_STATUSES, protocolOf, responseProblem, RETAINED_ON_CLOSE } from './legal.rules';
import { ORDER_STATUSES } from '../store/store.rules';

describe('regras de privacidade (LGPD)', () => {
  it('prazo de resposta: 15 dias depois da confirmação do e-mail', () => {
    const v = new Date('2026-11-08T12:00:00Z');
    expect(dueDate(v).toISOString()).toBe('2026-11-23T12:00:00.000Z');
    expect(daysLeft(dueDate(v), v)).toBe(15);
  });

  it('protocolo legível com ano e sequência', () => {
    expect(protocolOf(2026, 123)).toBe('LGPD-2026-000123');
  });

  it('status: sem e-mail confirmado não anda; fechado não reabre', () => {
    expect(canMove('unverified', 'open')).toBe(false);
    expect(canMove('open', 'in_progress')).toBe(true);
    expect(canMove('in_progress', 'done')).toBe(true);
    expect(canMove('done', 'open')).toBe(false);
    expect(canMove('rejected', 'in_progress')).toBe(false);
  });

  it('recusa exige motivo (art. 18, §4º) e conclusão exige resposta', () => {
    expect(responseProblem('rejected', '')).toMatch(/motivo/);
    expect(responseProblem('done', 'ok')).toMatch(/resposta/);
    expect(responseProblem('done', 'Seus dados foram excluídos em 08/11.')).toBeNull();
    expect(responseProblem('in_progress', '')).toBeNull();
  });

  it('pedidos em andamento que impedem excluir a conta são status reais de pedido', () => {
    for (const s of OPEN_ORDER_STATUSES) expect(ORDER_STATUSES).toContain(s);
    expect(OPEN_ORDER_STATUSES).not.toContain('delivered');
    expect(OPEN_ORDER_STATUSES).not.toContain('cancelled');
  });

  it('ao encerrar a conta só ficam faturas e lançamentos da taxa', () => {
    expect([...RETAINED_ON_CLOSE].sort()).toEqual(['FeeEntry', 'Invoice']);
  });
});

import { AccessLogSchemaFactory, AccountClosureSchemaFactory, ConsentLogSchemaFactory, PrivacyRequestSchemaFactory } from './legal.schema';
describe('registros legais sobrevivem à exclusão da conta', () => {
  it('nenhum tem o campo enterpriseId (a exclusão apaga tudo que tem esse campo)', () => {
    for (const s of [AccessLogSchemaFactory, AccountClosureSchemaFactory, ConsentLogSchemaFactory, PrivacyRequestSchemaFactory]) expect(s.path('enterpriseId')).toBeUndefined();
  });
  it('registro de acesso some sozinho em 190 dias; prova de aceite e encerramento em 5 anos', () => {
    const ttl = (s: typeof AccessLogSchemaFactory) => s.indexes().find(([, o]) => o?.expireAfterSeconds)?.[1]?.expireAfterSeconds;
    expect(ttl(AccessLogSchemaFactory)).toBe(190 * 86_400);
    expect(ttl(ConsentLogSchemaFactory)! / 86_400 / 365).toBeGreaterThanOrEqual(5);
    expect(ttl(AccountClosureSchemaFactory)! / 86_400 / 365).toBeGreaterThanOrEqual(5);
  });
});
