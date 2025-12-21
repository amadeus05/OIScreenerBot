import { In, Repository } from 'typeorm';
import { Injectable } from '../../shared/decorators';
import { Trade } from '../../domain/entities/trade.entity';
import { ITradeRepository } from '../../domain/interfaces/trade.interface';
import { AppDataSource } from '../database/database.module';

@Injectable()
export class TradeRepository implements ITradeRepository {
  private readonly repository: Repository<Trade>;

  constructor() {
    this.repository = AppDataSource.getRepository(Trade);
  }

  async createTrade(payload: Parameters<ITradeRepository['createTrade']>[0]): Promise<Trade> {
    const trade = this.repository.create({
      status: 'NEW',
      ...payload,
    });
    return this.repository.save(trade);
  }

  async updateTrade(id: number, patch: Partial<Trade>): Promise<Trade> {
    await this.repository.update({ id }, patch);
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Trade with id ${id} not found`);
    }
    return updated;
  }

  async findById(id: number): Promise<Trade | null> {
    return this.repository.findOne({ where: { id } });
  }

  async findOpenTrades(): Promise<Trade[]> {
    return this.repository.find({
      where: {
        status: In(['NEW', 'SUBMITTED', 'PARTIALLY_FILLED', 'PENDING_CANCEL']),
      },
      order: { createdAt: 'DESC' },
    });
  }
}

