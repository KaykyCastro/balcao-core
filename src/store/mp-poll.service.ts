import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { crossTenant } from '../common/security/tenant-guard.plugin';
import { MpPoll } from './schema/mp-poll.schema';
import { isFinalOutcome, nextPollAt, POLL_WINDOW_MS } from './mp-token.rules';

export type PollKind = MpPoll['kind'];
type Row = MpPoll & { _id: Types.ObjectId };
const LEASE_MS = 45_000;

/**
 * Agenda e vez das consultas automáticas das cobranças do modo token (ver mp-token.rules.ts). Quem consulta (rotina,
 * aviso do Mercado Pago, tela do caixa) pega a vez com `lease`; quem não consegue pula, porque alguém já está
 * consultando aquela cobrança agora. A confirmação em si continua idempotente em cada serviço (pedido, conta, caixa).
 */
@Injectable()
export class MpPollService {
  private readonly polls: Model<MpPoll>;
  constructor(@InjectModel(MpPoll.name) polls: Model<MpPoll>) {
    this.polls = crossTenant(polls, 'consulta automática do Mercado Pago (modo token): cobranças de todas as lojas');
  }

  /** Começa a acompanhar uma cobrança (repetir não duplica). */
  async track(kind: PollKind, refId: Types.ObjectId | string, enterpriseId: Types.ObjectId | string, startedAt: Date) {
    const now = new Date();
    await this.polls.updateOne(
      { kind, refId: new Types.ObjectId(String(refId)) },
      { $setOnInsert: { enterpriseId: new Types.ObjectId(String(enterpriseId)), startedAt, next: new Date(now.getTime() + 10_000), fails: 0, lockUntil: null, expireAt: new Date(startedAt.getTime() + 2 * POLL_WINDOW_MS + 3_600_000) } },
      { upsert: true },
    );
  }

  /** Cobranças cuja vez de consultar chegou (e que ninguém está consultando). */
  async due(limit = 25): Promise<Row[]> {
    const now = new Date();
    return this.polls.find({ next: { $lte: now }, $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }] }).sort({ next: 1 }).limit(limit).lean() as unknown as Row[];
  }

  /** Pega a vez de consultar. false = outra consulta da mesma cobrança está em andamento. */
  async claim(kind: PollKind, refId: Types.ObjectId | string): Promise<Row | null | false> {
    const now = new Date();
    const filter = { kind, refId: new Types.ObjectId(String(refId)) };
    const got = await this.polls.findOneAndUpdate({ ...filter, $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }] }, { $set: { lockUntil: new Date(now.getTime() + LEASE_MS) } }, { returnDocument: 'after' }).lean();
    if (got) return got as unknown as Row;
    return (await this.polls.exists(filter)) ? false : null; // null: cobrança não acompanhada (OAuth ou já resolvida)
  }

  /**
   * Depois de consultar: resultado final (pago, recusado, expirado…) ou fim da janela → para de acompanhar.
   * Ainda pendente → próxima consulta; `failed` (erro do Mercado Pago) espaça mais (backoff).
   */
  async settle(row: Pick<Row, 'kind' | 'refId' | 'startedAt' | 'fails'>, outcome: string, failed = false) {
    const filter = { kind: row.kind, refId: row.refId };
    const fails = failed ? (row.fails ?? 0) + 1 : 0;
    const next = isFinalOutcome(outcome) ? null : nextPollAt(new Date(row.startedAt), new Date(), fails);
    if (!next) { await this.polls.deleteOne(filter); return; }
    await this.polls.updateOne(filter, { $set: { next, fails, lockUntil: null } });
  }

  /**
   * Roda `fn` com a vez da cobrança. Não acompanhada (OAuth): roda direto. Acompanhada e livre: pega a vez, roda e
   * reagenda pelo resultado. Ocupada: não roda (devolve `skipped`), quem está com a vez resolve.
   */
  async lease<T extends string>(kind: PollKind, refId: Types.ObjectId | string, fn: () => Promise<T>): Promise<T | 'skipped'> {
    const row = await this.claim(kind, refId);
    if (row === false) return 'skipped';
    if (row === null) return fn();
    try {
      const out = await fn();
      await this.settle(row, out);
      return out;
    } catch (e) {
      await this.settle(row, 'error', true);
      throw e;
    }
  }

  async stop(kind: PollKind, refId: Types.ObjectId | string) {
    await this.polls.deleteOne({ kind, refId: new Types.ObjectId(String(refId)) });
  }
}
