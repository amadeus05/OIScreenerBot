/**
 * Chart Generator for Backtest Trade Visualization
 * Generates standalone HTML files with TradingView Lightweight Charts
 */

import * as fs from 'fs';
import * as path from 'path';
import { BarData, TradeAction } from '../../src/domain/signal-analyzer';

export interface TradeChartData {
    symbol: string;
    action: TradeAction;
    entryPrice: number;
    sl: number;
    tp: number[];
    bars: BarData[];
    timestamp: number;
}

/**
 * Generates an HTML file with interactive charts for a trade signal
 */
export function generateTradeChart(data: TradeChartData, outputDir: string): void {
    // Ensure output directory exists
    const fullOutputDir = path.resolve(process.cwd(), outputDir);
    if (!fs.existsSync(fullOutputDir)) {
        fs.mkdirSync(fullOutputDir, { recursive: true });
    }

    // Format timestamp for filename
    const date = new Date(data.timestamp);
    const dateStr = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${data.symbol}_${data.action}_${dateStr}.html`;
    const filepath = path.join(fullOutputDir, filename);

    // Prepare chart data
    const candleData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
    }));

    const oiData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        value: b.oi,
    }));

    const fundingData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        value: b.funding * 100, // Convert to percentage
    }));

    const liqLongData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        value: b.liquidations?.long || 0,
    }));

    const liqShortData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        value: b.liquidations?.short || 0,
    }));

    const cvdData = data.bars.map(b => ({
        time: Math.floor(b.ts / 1000) as number,
        value: b.cvd,
    }));

    const entryTime = Math.floor(data.timestamp / 1000);
    const isLong = data.action === 'LONG';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.symbol} ${data.action} - ${dateStr}</title>
    <script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #131722;
            color: #d1d4dc;
            padding: 16px;
        }
        .header { 
            display: flex; 
            align-items: center; 
            gap: 16px; 
            margin-bottom: 16px;
            padding: 12px 16px;
            background: #1e222d;
            border-radius: 8px;
        }
        .header h1 { font-size: 20px; color: #fff; }
        .badge { 
            padding: 4px 12px; 
            border-radius: 4px; 
            font-weight: 600;
            font-size: 12px;
        }
        .badge-long { background: #26a69a; color: #fff; }
        .badge-short { background: #ef5350; color: #fff; }
        .info-row {
            display: flex;
            gap: 24px;
            font-size: 13px;
            color: #787b86;
        }
        .info-row span { color: #d1d4dc; }
        .chart-container { 
            background: #1e222d; 
            border-radius: 8px; 
            margin-bottom: 8px;
            overflow: hidden;
        }
        .chart-label {
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 600;
            color: #787b86;
            background: #262b3e;
            border-bottom: 1px solid #363c4e;
        }
        #priceChart { height: 350px; }
        #oiChart { height: 120px; }
        #fundingChart { height: 100px; }
        #liqChart { height: 120px; }
        #cvdChart { height: 120px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>${data.symbol}</h1>
        <span class="badge ${isLong ? 'badge-long' : 'badge-short'}">${data.action}</span>
        <div class="info-row">
            <div>Entry: <span>${data.entryPrice.toFixed(4)}</span></div>
            <div>SL: <span>${data.sl.toFixed(4)}</span></div>
            <div>TP: <span>${data.tp.map(t => t.toFixed(4)).join(', ')}</span></div>
            <div>Time: <span>${new Date(data.timestamp).toLocaleString()}</span></div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-label">PRICE (1m)</div>
        <div id="priceChart"></div>
    </div>

    <div class="chart-container">
        <div class="chart-label">OPEN INTEREST</div>
        <div id="oiChart"></div>
    </div>

    <div class="chart-container">
        <div class="chart-label">FUNDING RATE (%)</div>
        <div id="fundingChart"></div>
    </div>

    <div class="chart-container">
        <div class="chart-label">LIQUIDATIONS (Long: Red, Short: Green)</div>
        <div id="liqChart"></div>
    </div>

    <div class="chart-container">
        <div class="chart-label">CVD (Cumulative Volume Delta)</div>
        <div id="cvdChart"></div>
    </div>

    <script>
        const candleData = ${JSON.stringify(candleData)};
        const oiData = ${JSON.stringify(oiData)};
        const fundingData = ${JSON.stringify(fundingData)};
        const liqLongData = ${JSON.stringify(liqLongData)};
        const liqShortData = ${JSON.stringify(liqShortData)};
        const cvdData = ${JSON.stringify(cvdData)};

        const entryPrice = ${data.entryPrice};
        const slPrice = ${data.sl};
        const tpPrices = ${JSON.stringify(data.tp)};
        const entryTime = ${entryTime};
        const isLong = ${isLong};

        const commonOptions = {
            layout: {
                background: { type: 'solid', color: '#1e222d' },
                textColor: '#d1d4dc',
            },
            grid: {
                vertLines: { color: '#2b2f3a' },
                horzLines: { color: '#2b2f3a' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: '#363c4e',
            },
            rightPriceScale: {
                borderColor: '#363c4e',
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
        };

        // Price Chart
        const priceChartEl = document.getElementById('priceChart');
        const priceChart = LightweightCharts.createChart(priceChartEl, {
            ...commonOptions,
            height: 350,
        });

        const candleSeries = priceChart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderUpColor: '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
            priceFormat: {
                type: 'price',
                precision: 6,
                minMove: 0.000001,
            },
        });
        candleSeries.setData(candleData);

        // Entry line
        candleSeries.createPriceLine({
            price: entryPrice,
            color: '#2196f3',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: 'ENTRY',
        });

        // SL line
        candleSeries.createPriceLine({
            price: slPrice,
            color: '#ef5350',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'SL',
        });

        // TP lines
        tpPrices.forEach((tp, i) => {
            candleSeries.createPriceLine({
                price: tp,
                color: '#26a69a',
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'TP' + (i > 0 ? (i + 1) : ''),
            });
        });

        // Entry marker
        candleSeries.setMarkers([{
            time: entryTime,
            position: isLong ? 'belowBar' : 'aboveBar',
            color: isLong ? '#26a69a' : '#ef5350',
            shape: isLong ? 'arrowUp' : 'arrowDown',
            text: isLong ? 'LONG' : 'SHORT',
        }]);

        // OI Chart
        const oiChartEl = document.getElementById('oiChart');
        const oiChart = LightweightCharts.createChart(oiChartEl, {
            ...commonOptions,
            height: 120,
        });
        const oiSeries = oiChart.addLineSeries({
            color: '#f57c00',
            lineWidth: 2,
        });
        oiSeries.setData(oiData);

        // Funding Chart
        const fundingChartEl = document.getElementById('fundingChart');
        const fundingChart = LightweightCharts.createChart(fundingChartEl, {
            ...commonOptions,
            height: 100,
        });
        const fundingSeries = fundingChart.addHistogramSeries({
            color: '#7e57c2',
            priceFormat: {
                type: 'price',
                precision: 6,
                minMove: 0.000001,
            },
        });
        fundingSeries.setData(fundingData);

        // Liquidations Chart
        const liqChartEl = document.getElementById('liqChart');
        const liqChart = LightweightCharts.createChart(liqChartEl, {
            ...commonOptions,
            height: 120,
        });
        const liqLongSeries = liqChart.addHistogramSeries({
            color: '#ef5350',
            priceFormat: {
                type: 'volume',
                precision: 0,
            },
            priceScaleId: 'right',
            lastValueVisible: false,
            priceLineVisible: false,
        });
        liqLongSeries.setData(liqLongData);

        const liqShortSeries = liqChart.addHistogramSeries({
            color: '#26a69a',
            priceFormat: {
                type: 'volume',
                precision: 0,
            },
            priceScaleId: 'right',
            lastValueVisible: false,
            priceLineVisible: false,
        });
        liqShortSeries.setData(liqShortData.map(d => ({ ...d, value: -d.value })));

        // CVD Chart
        const cvdChartEl = document.getElementById('cvdChart');
        const cvdChart = LightweightCharts.createChart(cvdChartEl, {
            ...commonOptions,
            height: 120,
        });
        const cvdSeries = cvdChart.addLineSeries({
            color: '#42a5f5',
            lineWidth: 2,
        });
        cvdSeries.setData(cvdData);

        // Sync all charts
        const charts = [priceChart, oiChart, fundingChart, liqChart, cvdChart];
        
        function syncCharts(sourceChart) {
            const timeRange = sourceChart.timeScale().getVisibleLogicalRange();
            if (timeRange !== null) {
                charts.forEach(chart => {
                    if (chart !== sourceChart) {
                        chart.timeScale().setVisibleLogicalRange(timeRange);
                    }
                });
            }
        }

        charts.forEach(chart => {
            chart.timeScale().subscribeVisibleLogicalRangeChange(() => syncCharts(chart));
        });

        // Sync crosshair
        function syncCrosshair(sourceChart, point) {
            charts.forEach(chart => {
                if (chart !== sourceChart && point) {
                    chart.setCrosshairPosition(point.value || 0, point.time, chart.getSeries()[0]);
                }
            });
        }

        charts.forEach(chart => {
            chart.subscribeCrosshairMove(param => {
                if (param.time) {
                    syncCrosshair(chart, { time: param.time, value: param.seriesData?.get(chart.getSeries()[0])?.close });
                }
            });
        });

        // Fit content
        charts.forEach(chart => chart.timeScale().fitContent());
    </script>
</body>
</html>`;

    fs.writeFileSync(filepath, html, 'utf-8');
    console.log(`   📊 Chart saved: ${filename}`);
}
