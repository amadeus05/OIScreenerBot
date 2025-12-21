import { Application, Router } from 'express';
import { DIContainer } from '../../shared/container';
import {
  ClosePositionRequest,
  ITradeRepository,
  ITradeService,
  PlaceOrderRequest,
} from '../../domain/interfaces/trade.interface';

function serializeError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const err = error as any;
  return {
    message: err.message,
    name: err.name,
    code: err.code,
    response: err.response?.data ?? err.response,
  };
}

export function registerTradeRoutes(
  server: Application,
  container: DIContainer,
): void {
  const router = Router();

  const getTradeService = (): ITradeService =>
    container.get<ITradeService>('ITradeService');
  const getTradeRepository = (): ITradeRepository =>
    container.get<ITradeRepository>('ITradeRepository');

  router.post('/', async (req, res) => {
    const body = req.body as Partial<PlaceOrderRequest>;

    if (!body.symbol || !body.side || !body.type || !body.quantity) {
      res.status(400).json({
        message: 'symbol, side, type и quantity обязательны',
      });
      return;
    }

    try {
      const trade = await getTradeService().placeOrder(body as PlaceOrderRequest);
      res.status(201).json(trade);
    } catch (error) {
      res.status(400).json({
        message: 'Не удалось разместить ордер',
        error: serializeError(error),
      });
    }
  });

  router.post('/close', async (req, res) => {
    const body = req.body as Partial<ClosePositionRequest>;
    if (!body.symbol) {
      res.status(400).json({ message: 'symbol обязателен' });
      return;
    }
    try {
      await getTradeService().closePosition(body as ClosePositionRequest);
      res.status(202).json({ message: 'Запрошено закрытие позиции' });
    } catch (error) {
      res.status(400).json({
        message: 'Не удалось закрыть позицию',
        error: serializeError(error),
      });
    }
  });

  router.get('/positions', async (_req, res) => {
    try {
      const positions = await getTradeService().listOpenPositions();
      res.json(positions);
    } catch (error) {
      res.status(500).json({
        message: 'Не удалось получить открытые позиции',
        error: serializeError(error),
      });
    }
  });

  router.get('/open-trades', async (_req, res) => {
    try {
      const trades = await getTradeRepository().findOpenTrades();
      res.json(trades);
    } catch (error) {
      res.status(500).json({
        message: 'Не удалось получить сделки из БД',
        error: serializeError(error),
      });
    }
  });

  server.use('/trades', router);
}

