import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport?: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SMTP_URL');
    if (url) this.transport = nodemailer.createTransport(url);
  }

  /** Falha de envio nunca vira erro para quem pediu (não revela se o e-mail existe). */
  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transport) {
      if (this.config.get('NODE_ENV') === 'production') this.logger.error('SMTP_URL não configurado: e-mail não enviado');
      else this.logger.warn(`[dev] e-mail para ${to}: ${subject}\n${text}`);
      return;
    }
    try {
      await this.transport.sendMail({ from: this.config.get('MAIL_FROM') ?? 'Balcão ERP <no-reply@localhost>', to, subject, text });
    } catch (e) {
      this.logger.error(`Falha ao enviar e-mail: ${(e as Error).message}`);
    }
  }
}
