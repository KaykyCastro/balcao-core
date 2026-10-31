import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, HydratedDocument } from 'mongoose';

export type CategoryDocument = HydratedDocument<CategorySchema>;

@Schema({ timestamps: true })
export class CategorySchema {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'EnterpriseSchema', required: true, index: true })
  enterpriseId: Types.ObjectId;
}

export const CategorySchemaFactory = SchemaFactory.createForClass(CategorySchema);
// Nome único POR empresa (antes era global).
CategorySchemaFactory.index({ enterpriseId: 1, name: 1 }, { unique: true });
