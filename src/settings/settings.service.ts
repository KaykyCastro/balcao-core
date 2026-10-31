import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlatformSettings } from './settings.schema';

export const DEFAULT_CAP_CENTS = 4000; // R$ 40,00
export const DEFAULT_TRIAL_DAYS = 30;
export const CAP_MAX_CENTS = 1_000_000; // R$ 10.000,00
export const TRIAL_MAX_DAYS = 365;
export const DEFAULT_ONLINE_RATE_BPS = 150; // 1,5% (venda pelo link da própria loja)
export const DEFAULT_DIRECTORY_RATE_BPS = 300; // 3% (cliente veio da página "Lojas no Balcão")
export const ONLINE_RATE_MAX_BPS = 2000; // 20%
const KEY = 'billing';
const CACHE_MS = 15_000;

export interface BillingPolicy { capCents: number; trialDays: number; onlineRateBps: number; directoryRateBps: number }

@Injectable()
export class SettingsService {
  private cache: { at: number; value: BillingPolicy } | null = null;
  constructor(@InjectModel(PlatformSettings.name) private readonly model: Model<PlatformSettings>) {}

  /** Política atual (com cache curto, já que é lida a cada venda). */
  async policy(): Promise<BillingPolicy> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const doc = await this.model.findOne({ key: KEY }).lean();
    const value: BillingPolicy = {
      capCents: doc?.capCents ?? DEFAULT_CAP_CENTS, trialDays: doc?.trialDays ?? DEFAULT_TRIAL_DAYS,
      onlineRateBps: doc?.onlineRateBps ?? DEFAULT_ONLINE_RATE_BPS, directoryRateBps: doc?.directoryRateBps ?? DEFAULT_DIRECTORY_RATE_BPS,
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async update(patch: Partial<BillingPolicy>, by: string): Promise<BillingPolicy> {
    const set: Record<string, unknown> = { updatedBy: by };
    if (patch.capCents !== undefined) set.capCents = patch.capCents;
    if (patch.trialDays !== undefined) set.trialDays = patch.trialDays;
    if (patch.onlineRateBps !== undefined) set.onlineRateBps = patch.onlineRateBps;
    if (patch.directoryRateBps !== undefined) set.directoryRateBps = patch.directoryRateBps;
    await this.model.updateOne({ key: KEY }, { $set: set, $setOnInsert: { key: KEY } }, { upsert: true });
    this.cache = null;
    return this.policy();
  }
}
