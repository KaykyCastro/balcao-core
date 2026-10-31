import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';

/** A API responderia 500 (CastError) para ids malformados; aqui vira 400. Só aceita 24 hex. */
@Injectable()
export class ParseMongoIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value) || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException('Identificador inválido');
    }
    return value;
  }
}
