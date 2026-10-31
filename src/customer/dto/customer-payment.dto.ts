import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class CustomerPaymentDto {
  /** Valor em reais. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(10_000_000)
  amount: number;

  @IsOptional()
  @IsIn(['cash', 'pix', 'card', 'other'])
  method?: 'cash' | 'pix' | 'card' | 'other';
}
