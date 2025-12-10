// ========================================================================
// FILE: src/domain/signal-analyzer/rules/types.ts
// ========================================================================

import { Features } from '../types';

/**
 * Предикат: Функция, отвечающая на вопрос Да/Нет относительно состояния рынка
 */
export type Condition = (f: Features, context?: any) => boolean;

/**
 * Сценарий: Именованная рыночная ситуация
 */
export interface MarketScenario {
    id: string;             // Уникальный ID (для дебага)
    name: string;           // Человекочитаемое имя
    
    // Условия, которые должны выполниться ОДНОВРЕМЕННО
    conditions: Condition[]; 
    
    // Базовый вес сигнала (-1 = Short, 1 = Long)
    baseScore: number;      
    
    // Базовая надежность (0..1)
    reliability: number;    
    
    // Теги, которые будут добавлены к сигналу
    tags: string[];         

    // Флаг: нужно ли умножать скор на силу движения (strength)
    // В старом коде: score = 0.6 * strength
    useStrengthMultiplier?: boolean; 
}