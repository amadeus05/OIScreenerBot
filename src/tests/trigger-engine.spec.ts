import 'reflect-metadata';
import { TriggerEngineService } from '../infrastructure/services/trigger-engine.service';
import { ITriggerRepository } from '../domain/interfaces/repositories.interface';
import { IMarketDataRepository, INotificationService, ITechnicalAnalysisService } from '../domain/interfaces/services.interface';
import { UptimeService } from '../infrastructure/services/uptime.service';
import { Trigger } from '../domain/entities/trigger.entity';

// Mocks
const mockTriggerRepo = {
  getAllActive: jest.fn(),
} as unknown as ITriggerRepository;

const mockMarketRepo = {
  getHistory: jest.fn(),
  isWarm: jest.fn(),
} as unknown as IMarketDataRepository;

const mockTAService = {
  calculateChanges: jest.fn(),
} as unknown as ITechnicalAnalysisService;

const mockNotificationService = {
  processTrigger: jest.fn(),
} as unknown as INotificationService;

const mockUptimeService = {} as UptimeService;

describe('TriggerEngineService', () => {
  let engine: TriggerEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    engine = new TriggerEngineService(
      mockTriggerRepo,
      mockMarketRepo,
      mockTAService,
      mockNotificationService,
      mockUptimeService
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should NOT process updates if stopped', async () => {
    // Engine not started
    await engine.onPriceUpdate('BTCUSDT', 50000);
    jest.advanceTimersByTime(200);
    expect(mockTriggerRepo.getAllActive).not.toHaveBeenCalled();
  });

  it('should process update and FIRE trigger when condition met', async () => {
    engine.start();

    // 1. Setup Trigger (LONG if OI change >= 5%)
    const trigger = new Trigger();
    trigger.id = 1;
    trigger.userId = 123;
    // trigger.symbol = 'BTCUSDT'; // <--- УДАЛЕНО: У триггера нет символа, он глобальный
    trigger.direction = 'up';
    trigger.oiChangePercent = 5;
    trigger.timeIntervalMinutes = 15;
    trigger.isActive = true;

    (mockTriggerRepo.getAllActive as jest.Mock).mockReturnValue([trigger]);
    (mockMarketRepo.isWarm as jest.Mock).mockReturnValue(true);
    (mockMarketRepo.getHistory as jest.Mock).mockReturnValue([]); 
    
    // 2. Setup TA Service response (Mocking +6% OI Change)
    (mockTAService.calculateChanges as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      oiChangePercent: 6.0, // > 5.0, should fire
      oiStart: 100, oiEnd: 106,
      currentPrice: 50000, previousPrice: 49000, priceChangePercent: 2,
      totalVolume: 1000, cvdDelta: 500,
      liquidations: { long: 0, short: 10000 },
      timeWindowSeconds: 900
    });

    // 3. Simulate Price Update
    await engine.onPriceUpdate('BTCUSDT', 50000);

    // 4. Fast-forward debounce time (100ms)
    jest.advanceTimersByTime(150);

    // 5. Assertions
    expect(mockTriggerRepo.getAllActive).toHaveBeenCalled();
    expect(mockTAService.calculateChanges).toHaveBeenCalledWith(expect.anything(), 15);
    expect(mockNotificationService.processTrigger).toHaveBeenCalledWith(trigger, expect.objectContaining({
      symbol: 'BTCUSDT',
      oiChangePercent: 6.0
    }));
  });

  it('should NOT fire trigger when condition NOT met', async () => {
    engine.start();

    const trigger = new Trigger();
    trigger.direction = 'up';
    trigger.oiChangePercent = 5;
    trigger.timeIntervalMinutes = 15;

    (mockTriggerRepo.getAllActive as jest.Mock).mockReturnValue([trigger]);
    (mockMarketRepo.isWarm as jest.Mock).mockReturnValue(true);
    
    // Mock TA: +3% Change (Less than 5%)
    (mockTAService.calculateChanges as jest.Mock).mockReturnValue({
      oiChangePercent: 3.0, 
      symbol: 'ETHUSDT',
      liquidations: { long:0, short:0 }
    });

    await engine.onPriceUpdate('ETHUSDT', 3000);
    jest.advanceTimersByTime(150);

    expect(mockNotificationService.processTrigger).not.toHaveBeenCalled();
  });

  it('should respect debounce (batch processing)', async () => {
    engine.start();
    (mockTriggerRepo.getAllActive as jest.Mock).mockReturnValue([]);

    // Call updates multiple times quickly
    await engine.onPriceUpdate('BTCUSDT', 50000);
    await engine.onPriceUpdate('ETHUSDT', 3000);
    await engine.onPriceUpdate('BTCUSDT', 50001); // Update BTC price

    // Should not have called repo yet
    expect(mockTriggerRepo.getAllActive).not.toHaveBeenCalled();

    // Advance time
    jest.advanceTimersByTime(150);

    // Should have called ONCE
    expect(mockTriggerRepo.getAllActive).toHaveBeenCalledTimes(1);
  });
});