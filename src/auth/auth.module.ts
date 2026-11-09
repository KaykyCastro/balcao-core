import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

import { EnterprisesModule } from '../enterprise/enterprise.module';
import { StaffModule } from '../staff/staff.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthHandoff, AuthHandoffSchema } from './schema/handoff.schema';
import { AuthChallenge, AuthChallengeSchema } from './schema/challenge.schema';
import { TwoFactorService } from './two-factor.service';
import { GoogleService } from './google.service';

import { DesignModule } from '../design/design.module';
@Module({
  imports: [
    EnterprisesModule, StaffModule, DesignModule,
    MongooseModule.forFeature([{ name: AuthHandoff.name, schema: AuthHandoffSchema }, { name: AuthChallenge.name, schema: AuthChallengeSchema }]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256', expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '8h') as any },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy, TwoFactorService, GoogleService],
})
export class AuthModule {}
