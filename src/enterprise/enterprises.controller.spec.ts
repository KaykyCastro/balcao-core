import { Test, TestingModule } from '@nestjs/testing';
import { EnterprisesController } from './enterprise.controller';
import { EnterpriseService } from './enterprise.service';

describe('EnterprisesController', () => {
  let controller: EnterprisesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnterprisesController],
      providers: [EnterpriseService],
    }).compile();

    controller = module.get<EnterprisesController>(EnterprisesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
