┌─────────────────────────────────────────────────────────────────┐
│ BINANCE WEBSOCKET (Real-time)                                   │
│ ┌──────────────┐  ┌───────────────┐  ┌────────────────┐         │
│ │ Kline (1m)   │  │ MarkPrice     │  │ ForceOrder     │         │
│ │ OHLCV + CVD  │  │ Funding Rate  │  │ Liquidations   │         │
│ └──────────────┘  └───────────────┘  └────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ BINANCE PROVIDER (processKline, processLiquidation)             │
│ • Accumulates liquidations within candle                        │
│ • Emits MarketData on EVERY tick                                │
│ • Resets counters AFTER emit (on candle close)                  │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ MARKET DATA REPOSITORY (SymbolBuffer)                           │
│ • OVERWRITE strategy for same timestamp                         │
│ • Pending buffer for OI that arrives before candle              │
│ • Stores SmartCandle[] with full order flow data                │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ TRIGGER ENGINE (Debounced, Batched)                             │
│ • 100ms debounce window                                         │
│ • Batch processing (50 symbols max)                             │
│ • Cooldown system per trigger-symbol pair                       │
└─────────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│ TECHNICAL ANALYSIS SERVICE                                      │
│ • Finds start/end candles in time window                        │
│ • Calculates OI%, Price%, CVD Delta, Liquidations               │
└─────────────────────────────────────────────────────────────────┘