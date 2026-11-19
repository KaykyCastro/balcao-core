import type { Model } from 'mongoose';

/**
 * E-mail de contato da cobrança: numa filial, o da matriz (o e-mail da filial é interno e nunca recebe nada).
 * Usado nos avisos de fatura, no pagador do Mercado Pago e no pagamento automático.
 */
export async function contactEmail(enterprises: Model<any>, e: { email?: string | null; parentId?: unknown }): Promise<string> {
  if (!e.parentId) return e.email ?? '';
  const root = await enterprises.findById(e.parentId).select('email').lean<{ email?: string }>();
  return root?.email ?? '';
}
