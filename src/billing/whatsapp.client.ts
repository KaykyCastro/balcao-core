import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * WhatsApp oficial (Cloud API da Meta) para os avisos da fatura. Mensagem iniciada pela empresa precisa de um
 * modelo aprovado no Meta Business: WHATSAPP_TEMPLATE_INVOICE (padrão `balcao_fatura`, idioma pt_BR) com 4
 * variáveis no corpo: {{1}} nome, {{2}} situação ("sua fatura vence amanhã…"), {{3}} valor, {{4}} link.
 * Sem WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID, fica desligado (os avisos seguem por e-mail e no painel).
 */
@Injectable()
export class WhatsAppClient {
  private readonly log = new Logger('WhatsApp');
  constructor(private readonly config: ConfigService) {}

  get configured() { return !!(this.config.get('WHATSAPP_TOKEN') && this.config.get('WHATSAPP_PHONE_NUMBER_ID')); }

  async sendInvoiceTemplate(to: string, params: [string, string, string, string]): Promise<boolean> {
    if (!this.configured) return false;
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')!;
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.get<string>('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: this.config.get<string>('WHATSAPP_TEMPLATE_INVOICE') ?? 'balcao_fatura', language: { code: this.config.get<string>('WHATSAPP_TEMPLATE_LANG') ?? 'pt_BR' },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').slice(0, 300) })) }],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => { this.log.warn(`WhatsApp sem resposta: ${e.message}`); return null; });
    if (!res) return false;
    if (!res.ok) { this.log.warn(`WhatsApp recusou (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`); return false; }
    return true;
  }
}
