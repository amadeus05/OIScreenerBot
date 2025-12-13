// src/domain/entities/history-candle.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { SmartCandle } from '../interfaces/market-data.interface';

@Entity('history_candles')
@Index(['symbol', 'ts'], { unique: true }) // Уникальный индекс, чтобы не дублировать
export class HistoryCandle {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar' }) 
  @Index()
  symbol!: string;

  @Column({ type: 'integer' }) // В SQLite integer вмещает timestamp (ms)
  @Index()
  ts!: number;

  // Храним весь объект SmartCandle как JSON строку
  @Column('simple-json')
  data!: SmartCandle;
}