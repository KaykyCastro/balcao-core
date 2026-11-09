import { IsObject } from 'class-validator';

/** O conteúdo é conferido campo a campo por `sanitizePdvLayout` (pdv-layout.rules.ts). */
export class PdvLayoutDto {
  @IsObject()
  layout!: Record<string, unknown>;
}
