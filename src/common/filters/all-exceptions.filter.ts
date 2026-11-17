import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** " (empresa <id>[, colaborador <id>])" quando a requisição tem sessão: liga o erro do log à loja. */
function whoOf(req: { user?: { _id?: unknown; staff?: { id?: string } } }): string {
  const id = req.user?._id ? String(req.user._id) : '';
  if (!/^[a-f0-9]{24}$/i.test(id)) return '';
  return ` (empresa ${id}${req.user?.staff?.id ? `, colaborador ${req.user.staff.id}` : ''})`;
}

/**
 * Nunca devolve stack nem mensagens internas (Mongo, bcrypt...) ao cliente.
 * HttpException passa como está; o resto vira 500 genérico e o detalhe vai só para o log.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ method: string; url: string; user?: { _id?: unknown; staff?: { id?: string } } }>();
    const who = whoOf(req);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= 500) this.logger.error(`${req.method} ${req.url} -> ${status}: ${exception.message}${who}`);
      // Envio de arquivos (fotos de produto, loja, vídeos): toda recusa fica no log com a empresa e o código, para
      // o suporte achar com `grep <id da empresa>`. Só ids e o motivo; nada do arquivo nem dado pessoal.
      else if (status >= 400 && req.url.startsWith('/uploads')) {
        const code = typeof body === 'object' && body && 'code' in body ? ` ${String((body as { code?: unknown }).code)}` : '';
        this.logger.warn(`Envio de arquivo recusado: ${req.method} ${req.url.split('?')[0]} -> ${status}${code}: ${exception.message}${who}`);
      }
      return res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    }

    const name = (exception as { name?: string })?.name;
    if (name === 'CastError' || name === 'ValidationError') {
      return res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, message: 'Requisição inválida' });
    }
    if ((exception as { code?: number })?.code === 11000) {
      return res.status(HttpStatus.CONFLICT).json({ statusCode: 409, message: 'Registro duplicado' });
    }
    if ((exception as { type?: string })?.type === 'entity.too.large') {
      return res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ statusCode: 413, message: 'Requisição grande demais' });
    }
    this.logger.error(`${req.method} ${req.url}${who}: ${(exception as Error)?.stack ?? String(exception)}`);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Erro interno' });
  }
}
