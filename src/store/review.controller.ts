import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentEnterprise } from '../common/decorators/current-enterprise.decorator';
import { ParseMongoIdPipe } from '../common/pipes/parse-mongo-id.pipe';
import { IMAGE_RE } from '../products/dto/product-create.dto';
import { MAX_REVIEW_PHOTOS, MAX_REVIEW_TEXT } from './review.rules';
import { ReviewService } from './review.service';
import { StoreService } from './store.service';

class TokenDto { @IsString() @MaxLength(200) t: string }
class ReviewDto extends TokenDto {
  @IsMongoId() productId: string;
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(MAX_REVIEW_TEXT) text?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REVIEW_PHOTOS) @IsString({ each: true }) @Matches(IMAGE_RE, { each: true, message: 'Foto inválida' }) photos?: string[];
}
class PhotoDto extends TokenDto {
  @IsString() @MaxLength(60) contentType: string;
  @IsInt() @Min(1) size: number;
}
class PageQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) page?: number }
class StoreReviewsQuery {
  @IsOptional() @IsIn(['0', '1']) photos?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) limit?: number;
}
class ModerateDto {
  @IsOptional() @IsBoolean() hidden?: boolean;
  @IsOptional() @IsString() @MaxLength(600) reply?: string;
}

/** Avaliações na vitrine e pelo link do pedido (comprador com ou sem conta). */
@Public()
@Controller('public/store/:slug')
export class PublicReviewController {
  constructor(private readonly reviews: ReviewService, private readonly stores: StoreService) {}

  @Get('products/:pid/reviews')
  async list(@Param('slug') slug: string, @Param('pid', ParseMongoIdPipe) pid: string, @Query() q: PageQuery) {
    const { store } = await this.stores.publicBySlug(slug);
    return this.reviews.publicList(String(store.enterpriseId), pid, q.page ?? 1);
  }

  @Get('reviews')
  async store(@Param('slug') slug: string, @Query() q: StoreReviewsQuery) {
    const { store } = await this.stores.publicBySlug(slug);
    return this.reviews.publicStore(String(store.enterpriseId), { photos: q.photos === '1', limit: q.limit });
  }

  @Get('orders/:id/reviews')
  forOrder(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Query() q: TokenDto) { return this.reviews.forOrder(slug, id, q.t); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('orders/:id/reviews')
  create(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ReviewDto) {
    return this.reviews.create(slug, id, dto.t, dto);
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('orders/:id/review-photo') @HttpCode(200)
  presign(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: PhotoDto) { return this.reviews.presignPhoto(slug, id, dto.t, dto.contentType, dto.size); }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('orders/:id/review-photo/:uploadId/complete') @HttpCode(200)
  complete(@Param('slug') slug: string, @Param('id', ParseMongoIdPipe) id: string, @Param('uploadId', ParseMongoIdPipe) uploadId: string, @Body() dto: TokenDto) {
    return this.reviews.completePhoto(slug, id, dto.t, uploadId);
  }
}

/** Avaliações para o lojista: ver, responder e ocultar (só o dono). */
@Controller('store-config/reviews')
export class MerchantReviewController {
  constructor(private readonly reviews: ReviewService) {}
  @Get()
  list(@CurrentEnterprise() eid: string, @Query() q: PageQuery) { return this.reviews.merchantList(eid, q.page ?? 1); }
  @Patch(':id')
  moderate(@CurrentEnterprise() eid: string, @Param('id', ParseMongoIdPipe) id: string, @Body() dto: ModerateDto) { return this.reviews.moderate(eid, id, dto); }
}
