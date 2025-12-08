import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, UpdateDateColumn } from 'typeorm';
import { TradeAction, EntryType, ConfidenceLevel, ModuleName } from '../signal-analyzer/types';

export enum SignalStatus {
    PENDING = 'PENDING',  // Сигнал активен, ждем исхода
    WIN = 'WIN',          // Достигнут TP
    LOSS = 'LOSS',        // Достигнут SL
    EXPIRED = 'EXPIRED',  // Время вышло (horizonMin)
    CANCELED = 'CANCELED' // Цена ушла не туда до входа (для лимиток)
}

@Entity('analization_results')
export class AnalizationResult {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'datetime' })
    @Index()
    ts!: Date;

    @Column({ type: 'varchar' })
    @Index()
    symbol!: string;

    @Column({ type: 'varchar' })
    action!: TradeAction;

    @Column({ type: 'varchar' })
    entryType!: EntryType;

    @Column('decimal', { precision: 18, scale: 8 })
    entryPrice!: number;

    @Column('decimal', { precision: 18, scale: 8 })
    sl!: number;

    @Column('simple-array')
    tp!: number[];

    @Column('simple-array')
    tpPct!: number[];

    @Column('int')
    horizonMin!: number;

    @Column('decimal', { precision: 5, scale: 4 })
    confidence!: number;

    @Column({ type: 'varchar' })
    confidenceLevel!: ConfidenceLevel;

    @Column('simple-json')
    modules!: Record<ModuleName, number>;

    @Column('simple-array')
    reasonTags!: string[];

    @Column('decimal', { precision: 5, scale: 4 })
    riskPct!: number;

    @Column('simple-json')
    meta!: {
        rawScore: number;
        moduleAgreement: number;
        [key: string]: any;
    };

    @CreateDateColumn({ type: 'datetime' })
    @Index()
    createdAt!: Date;


    // === НОВЫЕ ПОЛЯ ДЛЯ ВЕРИФИКАЦИИ ===

    @Column({ type: 'varchar', default: SignalStatus.PENDING })
    @Index()
    status!: SignalStatus;

    @Column('decimal', { precision: 18, scale: 8, nullable: true })
    exitPrice!: number | null;

    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    realizedPnlPct!: number | null; // % профита или убытка

    @Column('decimal', { precision: 18, scale: 8, nullable: true })
    maxPriceReached!: number | null; // Максимальная цена, куда доходил рынок (для анализа жадности)


    @Column({ type: 'datetime', nullable: true })
    closedAt!: Date | null;

    @UpdateDateColumn()
    updatedAt!: Date;
}
