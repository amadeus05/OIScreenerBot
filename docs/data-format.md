# Signal Analyzer - Data Format & Sources

## Overview

Приложение собирает данные с Binance Futures и сохраняет их в Supabase для анализа.

---

## Data Sources

### 1. Binance Futures WebSocket

**Provider:** `BinanceMarketDataProvider`

| Stream | URL | Данные |
|--------|-----|--------|
| Kline 1m | `wss://fstream.binance.com/stream` | OHLCV свечи |
| Ticker | `wss://fstream.binance.com/stream` | Last price |
| Depth | `wss://fstream.binance.com/stream` | Order book delta |
| Liquidations | `wss://fstream.binance.com/stream` | Ликвидации |

**REST API:**
- Open Interest: `GET /fapi/v1/openInterest`
- Funding Rate: `GET /fapi/v1/fundingRate`

---

## Data Format

### BarData (1-minute candle)

```typescript
interface BarData {
  symbol: string;      // "BTCUSDT"
  ts: number;          // Unix timestamp (ms) начала свечи
  
  // OHLCV
  o: number;           // Open price
  h: number;           // High price
  l: number;           // Low price
  c: number;           // Close price
  v: number;           // Volume (quote asset, USDT)
  
  // Order Flow
  delta: number;       // Buy Volume - Sell Volume (агрессоры)
  cvd: number;         // Cumulative Volume Delta (накопленный)
  
  // Open Interest
  oi: number;          // Current Open Interest (контракты)
  
  // Funding
  funding: number;     // Funding rate (0.0001 = 0.01%)
  
  // Price
  lastPrice: number;   // Last traded price
  
  // Liquidations
  liquidations: {
    long: number;      // Объем ликвидированных лонгов (USDT)
    short: number;     // Объем ликвидированных шортов (USDT)
    countLong: number; // Количество ликвидаций лонгов
    countShort: number; // Количество ликвидаций шортов
    maxLong: number;   // Максимальная ликвидация лонга
    maxShort: number;  // Максимальная ликвидация шорта
  };
}
```

---

## Supabase Table: `candles`

```sql
CREATE TABLE candles (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  ts BIGINT NOT NULL,           -- Unix timestamp
  o DECIMAL(20, 8),
  h DECIMAL(20, 8),
  l DECIMAL(20, 8),
  c DECIMAL(20, 8),
  v DECIMAL(20, 2),
  cvd DECIMAL(20, 2),
  delta DECIMAL(20, 2),
  oi DECIMAL(20, 2),
  funding DECIMAL(10, 8),
  liquidations JSONB,           -- {long, short, countLong, countShort, ...}
  last_price DECIMAL(20, 8),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(symbol, ts)
);

CREATE INDEX idx_candles_symbol_ts ON candles(symbol, ts DESC);
```

---

## Data Flow

```
┌─────────────────┐    WebSocket     ┌──────────────────────┐
│ Binance Futures │ ───────────────> │ BinanceMarketData    │
│   (Exchange)    │                  │    Provider          │
└─────────────────┘                  └──────────┬───────────┘
                                                │
                                                ▼
                                     ┌──────────────────────┐
                                     │ MarketDataGateway    │
                                     │ (Aggregates streams) │
                                     └──────────┬───────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    ▼                           ▼                           ▼
         ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
         │ MarketDataRepo   │       │ Supabase         │       │ TriggerEngine    │
         │ (In-Memory)      │       │ (Persistence)    │       │ (OI Alerts)      │
         └──────────────────┘       └──────────────────┘       └──────────────────┘
                    │                           │
                    ▼                           ▼
         ┌──────────────────┐       ┌──────────────────┐
         │ SignalAnalyzer   │<──────│ SupabaseProvider │
         │ (Analysis)       │       │ (Fetch history)  │
         └──────────────────┘       └──────────────────┘
```

---

## Calculated Features (FeatureEngine)

| Feature | Формула | Описание |
|---------|---------|----------|
| `flowImb` | `delta / volume` | Дисбаланс потока [-1, 1] |
| `volZ` | `(vol - mean) / std` | Z-score объема |
| `deltaZ` | `(delta - mean) / std` | Z-score дельты |
| `dCVD` | `CVD[n] - CVD[n-5]` | Изменение CVD за 5 баров |
| `dOI` | `OI[n] - OI[n-5]` | Изменение OI за 5 баров |
| `oiFlow` | `dOI / mean(OI)` | Нормализованный поток OI |
| `atr` | `ATR(14)` | Average True Range |
| `emaFast` | `EMA(8)` | Быстрая EMA |
| `emaSlow` | `EMA(21)` | Медленная EMA |

---

## Environment Variables

```env
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_API_KEY=eyJ...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALERT_CHAT_ID=123456789

# Data Source
SIGNAL_ANALYZER_DATA_SOURCE=supabase  # or 'memory'
```
