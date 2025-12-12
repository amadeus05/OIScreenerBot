import * as fs from 'fs';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalFeatureVector } from '../../domain/signal-analyzer/types/ml.types';

@Injectable()
export class MlGuardService {
    private readonly logger = new Logger('MlGuard');
    private dataset: SignalFeatureVector[] = [];
    
    // НАСТРОЙКИ k-NN
    private readonly K_NEIGHBORS = 5; // Смотрим на 5 "соседей" в прошлом
    private readonly MIN_WINRATE = 0.4; // Если среди соседей < 40% побед, баним

    constructor() {
        this.loadDataset();
    }

    public reload(): void {
        this.loadDataset();
    }

    private loadDataset() {
        try {
            if (fs.existsSync('ml-dataset.json')) {
                const raw = fs.readFileSync('ml-dataset.json', 'utf-8');
                this.dataset = JSON.parse(raw);
                this.logger.info(`🧠 ML Brain loaded: ${this.dataset.length} patterns.`);
            }
        } catch (e) {
            this.logger.warn('ML Dataset not found or empty. Learning mode ON.');
        }
    }

    public check(currentFeatures: SignalFeatureVector['features']): boolean {
        // Если опыта мало (< 10 сделок), не мешаем работать
        if (this.dataset.length < 10) return true;

        // 1. Считаем дистанцию до ВСЕХ прошлых сделок
        const neighbors = this.dataset
            .map(sample => ({
                sample,
                distance: this.calculateDistance(currentFeatures, sample.features)
            }))
            // Сортируем: от самых похожих к непохожим
            .sort((a, b) => a.distance - b.distance) 
            // Берем топ-5 самых похожих
            .slice(0, this.K_NEIGHBORS);

        // 2. Анализируем, чем закончились эти похожие ситуации
        const wins = neighbors.filter(n => n.sample.outcome === 'WIN').length;
        const losses = neighbors.filter(n => n.sample.outcome === 'LOSS').length;
        
        // Вероятность успеха на основе истории
        const predictedWinRate = wins / this.K_NEIGHBORS;

        this.logger.debug(`🔮 ML Prediction: Based on ${this.K_NEIGHBORS} similar past events -> WinRate: ${(predictedWinRate * 100).toFixed(0)}%`);

        // 3. Вердикт
        if (predictedWinRate < this.MIN_WINRATE) {
            this.logger.warn(`⛔ ML BLOCK: Similar patterns failed ${losses}/${this.K_NEIGHBORS} times.`);
            return false; // БЛОКИРУЕМ
        }

        return true; // РАЗРЕШАЕМ
    }

    // Евклидово расстояние (Формула Пифагора в многомерном пространстве)
    // Чем меньше число, тем больше похожа ситуация
    private calculateDistance(a: any, b: any): number {
        return Math.sqrt(
            Math.pow(a.orderflowScore - b.orderflowScore, 2) +
            Math.pow(a.oiScore - b.oiScore, 2) +
            Math.pow(a.momentumScore - b.momentumScore, 2) +
            // Временной фактор (нормализуем час дня к 0..1)
            Math.pow((a.hour / 24) - (b.hour / 24), 2)
        );
    }
}