import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  PositionSide,
  TimeInForce,
  TradeSide,
  TradeStatus,
  TradeType,
} from '../types/trade.types';

@Entity('trades')
export class Trade {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: 'varchar' })
  symbol!: string;

  @Column({ type: 'varchar' })
  side!: TradeSide;

  @Column({ type: 'varchar' })
  type!: TradeType;

  @Column({ type: 'integer', default: 1 })
  leverage!: number;

  @Column({ type: 'varchar', nullable: true })
  positionSide: PositionSide | null = null;

  @Column({ type: 'varchar', nullable: true })
  timeInForce: TimeInForce | null = null;

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  quantity!: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  price: number | null = null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  stopLoss: number | null = null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  takeProfit: number | null = null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  executedQuantity: number | null = null;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  averagePrice: number | null = null;

  @Column({ type: 'varchar', default: 'NEW' })
  status: TradeStatus = 'NEW';

  @Index()
  @Column({ type: 'varchar', nullable: true })
  binanceOrderId: string | null = null;

  @Column({ type: 'varchar', nullable: true })
  stopOrderId: string | null = null;

  @Column({ type: 'varchar', nullable: true })
  takeProfitOrderId: string | null = null;

  @Column({ type: 'varchar', nullable: true })
  clientOrderId: string | null = null;

  @Column({ type: 'integer', nullable: true })
  signalId: number | null = null;

  @Column({ type: 'varchar', nullable: true })
  source: string | null = null;

  @Column({ type: 'simple-array', nullable: true })
  tags: string[] | null = null;

  @Column({ type: 'simple-json', nullable: true })
  requestPayload?: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  exchangeResponse?: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  errorPayload?: Record<string, unknown> | null;

  @Column({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

