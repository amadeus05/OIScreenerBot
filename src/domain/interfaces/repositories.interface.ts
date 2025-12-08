import { Signal } from '../entities/signal.entity';
import { Trigger } from '../entities/trigger.entity';
import { CreateTriggerDto } from '../../application/dto/create-trigger.dto';
import { AnalizationResult } from '../../domain/entities/analization-result.entity';

export enum IndexDirection {
  asc = 'ASC',
  desc = 'DESC'
}
export interface IndexInterval{
  dateFrom: string,
  dateTo: string,
}
export interface IndexArgs {
  limit?: number,
  direction?: IndexDirection,
  interval?: IndexInterval
}

export interface ITriggerRepository {
  init(): Promise<void>;
  getAllActive(): Trigger[];
  findByUserId(userId: number): Promise<Trigger[]>;
  save(dto: CreateTriggerDto): Promise<Trigger>;
  remove(id: number, userId: number): Promise<boolean>;
}

export interface ISignalRepository {
  getLast24HoursSignalCount(userId: number): Promise<number>;
  getLast24HoursSignalCountByTriggerAndSymbol(triggerId: number, symbol: string): Promise<number>;
  getLast24HoursSignalCountBySymbol(userId: number, symbol: string): Promise<number>;
  save(signal: Signal): Promise<Signal>;
  findRecentBySymbol(symbol: string, hours: number): Promise<Signal[]>;
}

export interface IAnalizationResultRepository {
  save(result: AnalizationResult): Promise<AnalizationResult>;
  getAll(args: IndexArgs): Promise<AnalizationResult[]>
}
