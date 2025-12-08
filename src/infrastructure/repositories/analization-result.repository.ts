import { Repository } from 'typeorm';
import { Injectable } from '../../shared/decorators';
import { AppDataSource } from '../database/database.module';
import { AnalizationResult, SignalStatus } from '../../domain/entities/analization-result.entity';
import {
  IAnalizationResultRepository,
  IndexArgs,
} from '../../domain/interfaces/repositories.interface';

@Injectable()
export class AnalizationResultRepository implements IAnalizationResultRepository {
  private repository: Repository<AnalizationResult>;

  constructor() {
    this.repository = AppDataSource.getRepository(AnalizationResult);
  }

  async save(result: AnalizationResult): Promise<AnalizationResult> {
    return this.repository.save(result);
  }

  async getAll(args: IndexArgs): Promise<AnalizationResult[]> {
    const { limit, direction = 'ASC', interval } = args;

    const queryBuilder = this.repository.createQueryBuilder('result');

    // Apply date interval filter if provided
    if (interval) {
      queryBuilder.where('result.ts BETWEEN :dateFrom AND :dateTo', {
        dateFrom: interval.dateFrom,
        dateTo: interval.dateTo,
      });
    }

    // Apply sorting by timestamp
    queryBuilder.orderBy('result.ts', direction);

    // Apply limit if provided
    if (limit) {
      queryBuilder.limit(limit);
    }

    return queryBuilder.getMany();
  }

  /**
   * Получить все активные сигналы для проверки
   */
  async getPendingSignals(): Promise<AnalizationResult[]> {
    return this.repository.find({
      where: {
        status: SignalStatus.PENDING,
        // Можно добавить фильтр, чтобы не проверять совсем старые зависшие сигналы
        // например, созданные более 24 часов назад
      },
      order: {
        ts: 'ASC', // Проверяем старые первыми
      },
    });
  }
}
