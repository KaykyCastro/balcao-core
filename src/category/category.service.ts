import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import { CategorySchema, CategoryDocument } from './schema/category.schema';
import { CategoryCreateDto } from './dto/category-create.dto';
import { CategoryUpdateDto } from './dto/category-update.dto';
import { isDuplicateKeyError } from '../common/mongo';

@Injectable()
export class CategoryService {
  constructor(
    @InjectModel(CategorySchema.name) private readonly categoryModel: Model<CategorySchema>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async create(enterpriseId: string, dto: CategoryCreateDto): Promise<CategoryDocument> {
    try {
      return await this.categoryModel.create({ name: dto.name, enterpriseId });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Categoria já existe');
      throw e;
    }
  }

  async list(enterpriseId: string): Promise<CategoryDocument[]> {
    return this.categoryModel.find({ enterpriseId }).sort({ name: 1 });
  }

  async findCategoryById(enterpriseId: string, id: string): Promise<CategoryDocument> {
    const category = await this.categoryModel.findOne({ _id: id, enterpriseId });
    if (!category) throw new NotFoundException('Categoria não encontrada');
    return category;
  }

  async update(enterpriseId: string, id: string, dto: CategoryUpdateDto): Promise<CategoryDocument> {
    try {
      const updated = await this.categoryModel.findOneAndUpdate(
        { _id: id, enterpriseId },
        { $set: { name: dto.name } },
        { returnDocument: 'after', runValidators: true },
      );
      if (!updated) throw new NotFoundException('Categoria não encontrada');
      return updated;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ConflictException('Categoria já existe');
      throw e;
    }
  }

  async delete(enterpriseId: string, id: string): Promise<void> {
    // Consulta o model de produtos pela conexão (evita dependência circular entre módulos).
    const inUse = await this.connection.model('ProductSchema').exists({ enterpriseId, categoryId: id });
    if (inUse) throw new ConflictException('Existem produtos nesta categoria');
    const category = await this.categoryModel.findOneAndDelete({ _id: id, enterpriseId });
    if (!category) throw new NotFoundException('Categoria não encontrada');
  }
}
