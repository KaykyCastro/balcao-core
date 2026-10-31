import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './dto/register.dto';

const base = { name: 'Mercadinho', email: 'a@b.com', password: 'senha1234' };
const errs = async (o: object) => (await validate(plainToInstance(RegisterDto, o), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('Cadastro exige aceite dos Termos de Uso', () => {
  it('sem acceptTerms: recusa', async () => expect(await errs(base)).toContain('acceptTerms'));
  it('acceptTerms false ou "true" (texto): recusa', async () => {
    expect(await errs({ ...base, acceptTerms: false })).toContain('acceptTerms');
    expect(await errs({ ...base, acceptTerms: 'true' })).toContain('acceptTerms');
  });
  it('acceptTerms true: aceita, com ou sem versão', async () => {
    expect(await errs({ ...base, acceptTerms: true })).toEqual([]);
    expect(await errs({ ...base, acceptTerms: true, termsVersion: '2026-10-30' })).toEqual([]);
  });
  it('versão em formato estranho: recusa', async () => expect(await errs({ ...base, acceptTerms: true, termsVersion: '<script>' })).toContain('termsVersion'));
});
