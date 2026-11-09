import { HttpException, HttpStatus, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { randomInt } from 'crypto';
import { sha256, sign, verifySigned } from '../common/secret-box';
import { MailService } from '../mail/mail.service';

const TTL_MS = 10 * 60_000;
const TOKEN_MS = 3 * 3600_000;
const SCOPE = 'checkout-email';
const norm = (e: string) => e.trim().toLowerCase();

/**
 * Compra sem cadastro (como na Hotmart): a pessoa informa o e-mail, recebe um código de 6 dígitos e confirma.
 * O código prova que o e-mail é dela; o comprovante e o acompanhamento do pedido vão para esse e-mail.
 */
@Injectable()
export class EmailCodeService {
  private readonly logger = new Logger(EmailCodeService.name);
  private indexed = false;
  constructor(@InjectConnection() private readonly connection: Connection, private readonly mail: MailService) {}

  private get col() { return this.connection.collection('checkout_email_codes'); }
  private async ensureIndex() {
    if (this.indexed) return;
    this.indexed = true;
    await this.col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 }).catch(() => undefined);
    await this.col.createIndex({ email: 1, createdAt: -1 }).catch(() => undefined);
  }

  async send(emailRaw: string, storeName: string) {
    await this.ensureIndex();
    const email = norm(emailRaw);
    const now = Date.now();
    const recent = await this.col.find({ email, createdAt: { $gte: new Date(now - 3600_000) } }).sort({ createdAt: -1 }).limit(6).toArray();
    if (recent[0] && now - new Date(recent[0].createdAt).getTime() < 45_000) throw new HttpException({ code: 'CODE_TOO_SOON', message: 'Espere alguns segundos para pedir outro código.' }, HttpStatus.TOO_MANY_REQUESTS);
    if (recent.length >= 5) throw new HttpException({ code: 'CODE_LIMIT', message: 'Muitos códigos pedidos para este e-mail. Tente de novo em uma hora.' }, HttpStatus.TOO_MANY_REQUESTS);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.col.insertOne({ email, codeHash: sha256(`${email}:${code}`), attempts: 0, used: false, createdAt: new Date(now), expiresAt: new Date(now + TTL_MS) });
    await this.mail.send(email, `${code} é o seu código - ${storeName}`, `Seu código para confirmar o e-mail da compra na ${storeName}:\n\n${code}\n\nEle vale por 10 minutos. Se não foi você, ignore esta mensagem.`)
      .catch((e) => { this.logger.warn(`Código não enviado para ${email.replace(/^(.{2}).*@/, '$1***@')}: ${(e as Error).message}`); throw new UnprocessableEntityException('Não foi possível enviar o código agora. Confira o e-mail e tente de novo.'); });
    return { sent: true, expiresInSec: TTL_MS / 1000 };
  }

  /** Código certo: devolve um comprovante assinado do e-mail (vale 3 horas) para o checkout. */
  async verify(emailRaw: string, code: string) {
    const email = norm(emailRaw);
    const doc = await this.col.find({ email, used: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(1).next();
    if (!doc) throw new UnprocessableEntityException({ code: 'CODE_EXPIRED', message: 'Código expirado. Peça um novo.' });
    if (doc.attempts >= 5) throw new UnprocessableEntityException({ code: 'CODE_LOCKED', message: 'Muitas tentativas. Peça um novo código.' });
    if (doc.codeHash !== sha256(`${email}:${code.trim()}`)) {
      await this.col.updateOne({ _id: doc._id }, { $inc: { attempts: 1 } });
      throw new UnprocessableEntityException({ code: 'CODE_WRONG', message: 'Código incorreto.' });
    }
    await this.col.updateOne({ _id: doc._id }, { $set: { used: true } });
    const exp = Date.now() + TOKEN_MS;
    return { emailToken: `${exp}.${sign(SCOPE, `${email}.${exp}`)}`, email };
  }

  /** Confere o comprovante do e-mail no checkout. */
  static valid(emailRaw: string, token?: string | null): boolean {
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return verifySigned(SCOPE, `${norm(emailRaw)}.${exp}`, sig);
  }
}
