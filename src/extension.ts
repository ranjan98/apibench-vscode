import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

interface BenchmarkResult {
  url: string;
  method: string;
  timestamp: Date;
  duration: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerSecond: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  p50: number;
  p95: number;
  p99: number;
}

interface BenchmarkOptions {
  url: string;
  method: string;
  duration: number;
  connections: number;
  headers?: Record<string, string>;
  body?: string;
}

let benchmarkHistory: BenchmarkResult[] = [];
let historyProvider: BenchmarkHistoryProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('APIBench activated');

  // Load history
  benchmarkHistory = context.globalState.get('benchmarkHistory', []);

  // Register history view
  historyProvider = new BenchmarkHistoryProvider();
  vscode.window.registerTreeDataProvider('apibench.history', historyProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('apibench.runBenchmark', () => runBenchmark(context)),
    vscode.commands.registerCommand('apibench.quickTest', () => quickTest(context)),
    vscode.commands.registerCommand('apibench.showHistory', () => showHistory()),
    vscode.commands.registerCommand('apibench.compareResults', () => compareResults())
  );
}

async function runBenchmark(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('apibench');

  // Get URL
  const url = await vscode.window.showInputBox({
    prompt: 'Enter the URL to benchmark',
    placeHolder: 'https://api.example.com/endpoint',
    validateInput: (value) => {
      try {
        new URL(value);
        return null;
      } catch {
        return 'Please enter a valid URL';
      }
    }
  });

  if (!url) return;

  // Get method
  const method = await vscode.window.showQuickPick(
    ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    { placeHolder: 'Select HTTP method' }
  );

  if (!method) return;

  // Get duration
  const durationStr = await vscode.window.showInputBox({
    prompt: 'Benchmark duration (seconds)',
    value: config.get('defaultDuration', 10).toString(),
    validateInput: (value) => {
      const num = parseInt(value);
      return (isNaN(num) || num < 1 || num > 60) ? 'Enter 1-60 seconds' : null;
    }
  });

  if (!durationStr) return;

  // Get connections
  const connectionsStr = await vscode.window.showInputBox({
    prompt: 'Concurrent connections',
    value: config.get('defaultConnections', 10).toString(),
    validateInput: (value) => {
      const num = parseInt(value);
      return (isNaN(num) || num < 1 || num > 100) ? 'Enter 1-100 connections' : null;
    }
  });

  if (!connectionsStr) return;

  const options: BenchmarkOptions = {
    url,
    method,
    duration: parseInt(durationStr),
    connections: parseInt(connectionsStr)
  };

  // Get body for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const body = await vscode.window.showInputBox({
      prompt: 'Request body (JSON, optional)',
      placeHolder: '{"key": "value"}'
    });
    if (body) {
      options.body = body;
      options.headers = { 'Content-Type': 'application/json' };
    }
  }

  await executeBenchmark(context, options);
}

async function quickTest(context: vscode.ExtensionContext) {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter URL for quick test (5s, 5 connections)',
    placeHolder: 'https://api.example.com/endpoint'
  });

  if (!url) return;

  await executeBenchmark(context, {
    url,
    method: 'GET',
    duration: 5,
    connections: 5
  });
}

async function executeBenchmark(context: vscode.ExtensionContext, options: BenchmarkOptions) {
  const panel = vscode.window.createWebviewPanel(
    'apibenchResults',
    `APIBench: ${options.url}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = getLoadingHtml(options);

  try {
    const result = await runHttpBenchmark(options, (progress) => {
      panel.webview.postMessage({ type: 'progress', progress });
    });

    // Save to history
    if (vscode.workspace.getConfiguration('apibench').get('saveHistory', true)) {
      benchmarkHistory.unshift(result);
      if (benchmarkHistory.length > 50) benchmarkHistory.pop();
      await context.globalState.update('benchmarkHistory', benchmarkHistory);
      historyProvider.refresh();
    }

    panel.webview.html = getResultsHtml(result);
  } catch (error: any) {
    panel.webview.html = getErrorHtml(error.message);
  }
}

async function runHttpBenchmark(
  options: BenchmarkOptions,
  onProgress: (progress: number) => void
): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const latencies: number[] = [];
    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();
    const endTime = startTime + options.duration * 1000;
    let activeConnections = 0;

    const urlObj = new URL(options.url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const makeRequest = () => {
      if (Date.now() >= endTime) {
        if (activeConnections === 0) {
          finalize();
        }
        return;
      }

      activeConnections++;
      const reqStart = Date.now();

      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method,
        headers: options.headers || {},
        timeout: 30000
      };

      const req = httpModule.request(reqOptions, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const latency = Date.now() - reqStart;
          latencies.push(latency);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            successCount++;
          } else {
            failCount++;
          }
          activeConnections--;
          onProgress(Math.min(100, ((Date.now() - startTime) / (options.duration * 1000)) * 100));
          makeRequest();
        });
      });

      req.on('error', () => {
        failCount++;
        activeConnections--;
        makeRequest();
      });

      req.on('timeout', () => {
        failCount++;
        activeConnections--;
        req.destroy();
        makeRequest();
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    };

    const finalize = () => {
      const actualDuration = (Date.now() - startTime) / 1000;
      latencies.sort((a, b) => a - b);

      const percentile = (p: number) => {
        if (latencies.length === 0) return 0;
        const index = Math.ceil(latencies.length * p) - 1;
        return latencies[Math.max(0, index)];
      };

      resolve({
        url: options.url,
        method: options.method,
        timestamp: new Date(),
        duration: actualDuration,
        totalRequests: successCount + failCount,
        successfulRequests: successCount,
        failedRequests: failCount,
        requestsPerSecond: (successCount + failCount) / actualDuration,
        avgLatency: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
        minLatency: latencies.length > 0 ? latencies[0] : 0,
        maxLatency: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99)
      });
    };

    // Start connections
    for (let i = 0; i < options.connections; i++) {
      makeRequest();
    }
  });
}

function showHistory() {
  if (benchmarkHistory.length === 0) {
    vscode.window.showInformationMessage('No benchmark history available');
    return;
  }

  const items = benchmarkHistory.map((r, i) => ({
    label: `${r.method} ${r.url}`,
    description: `${r.requestsPerSecond.toFixed(1)} req/s | p99: ${r.p99.toFixed(0)}ms`,
    detail: new Date(r.timestamp).toLocaleString(),
    index: i
  }));

  vscode.window.showQuickPick(items, { placeHolder: 'Select to view details' }).then(selected => {
    if (selected) {
      const result = benchmarkHistory[selected.index];
      const panel = vscode.window.createWebviewPanel(
        'apibenchResults',
        `APIBench: ${result.url}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      panel.webview.html = getResultsHtml(result);
    }
  });
}

async function compareResults() {
  if (benchmarkHistory.length < 2) {
    vscode.window.showWarningMessage('Need at least 2 results to compare');
    return;
  }

  const items = benchmarkHistory.map((r, i) => ({
    label: `${r.method} ${r.url}`,
    description: `${r.requestsPerSecond.toFixed(1)} req/s`,
    index: i
  }));

  const first = await vscode.window.showQuickPick(items, { placeHolder: 'Select first result' });
  if (!first) return;

  const second = await vscode.window.showQuickPick(
    items.filter(i => i.index !== first.index),
    { placeHolder: 'Select second result' }
  );
  if (!second) return;

  const r1 = benchmarkHistory[first.index];
  const r2 = benchmarkHistory[second.index];

  const panel = vscode.window.createWebviewPanel(
    'apibenchCompare',
    'APIBench: Comparison',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = getCompareHtml(r1, r2);
}

function getLoadingHtml(options: BenchmarkOptions): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; background: #1e1e1e; color: #fff; }
    .loader { text-align: center; margin-top: 100px; }
    .spinner { width: 50px; height: 50px; border: 5px solid #333; border-top: 5px solid #007acc; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .progress-bar { width: 300px; height: 20px; background: #333; border-radius: 10px; margin: 20px auto; overflow: hidden; }
    .progress-fill { height: 100%; background: #007acc; width: 0%; transition: width 0.3s; }
    h2 { color: #007acc; }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <h2>Running Benchmark</h2>
    <p>${options.method} ${options.url}</p>
    <p>${options.duration}s | ${options.connections} connections</p>
    <div class="progress-bar"><div class="progress-fill" id="progress"></div></div>
  </div>
  <script>
    window.addEventListener('message', event => {
      if (event.data.type === 'progress') {
        document.getElementById('progress').style.width = event.data.progress + '%';
      }
    });
  </script>
</body>
</html>`;
}

function getResultsHtml(result: BenchmarkResult): string {
  const successRate = ((result.successfulRequests / result.totalRequests) * 100).toFixed(1);
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; background: #1e1e1e; color: #fff; }
    h1 { color: #007acc; margin-bottom: 5px; }
    .url { color: #888; font-size: 14px; margin-bottom: 30px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px; }
    .card { background: #2d2d2d; padding: 20px; border-radius: 8px; }
    .card-title { color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px; }
    .card-value { font-size: 28px; font-weight: bold; }
    .success { color: #4caf50; }
    .warning { color: #ff9800; }
    .error { color: #f44336; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    th { color: #888; font-weight: normal; }
    .bar { height: 20px; background: #007acc; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Benchmark Results</h1>
  <p class="url">${result.method} ${result.url}</p>

  <div class="grid">
    <div class="card">
      <div class="card-title">Requests/sec</div>
      <div class="card-value">${result.requestsPerSecond.toFixed(1)}</div>
    </div>
    <div class="card">
      <div class="card-title">Total Requests</div>
      <div class="card-value">${result.totalRequests.toLocaleString()}</div>
    </div>
    <div class="card">
      <div class="card-title">Success Rate</div>
      <div class="card-value ${parseFloat(successRate) > 99 ? 'success' : parseFloat(successRate) > 90 ? 'warning' : 'error'}">${successRate}%</div>
    </div>
  </div>

  <h2>Latency (ms)</h2>
  <table>
    <tr><th>Metric</th><th>Value</th><th></th></tr>
    <tr><td>Average</td><td>${result.avgLatency.toFixed(2)} ms</td><td><div class="bar" style="width: ${Math.min(100, result.avgLatency / result.maxLatency * 100)}%"></div></td></tr>
    <tr><td>Min</td><td>${result.minLatency.toFixed(2)} ms</td><td><div class="bar" style="width: ${Math.min(100, result.minLatency / result.maxLatency * 100)}%"></div></td></tr>
    <tr><td>Max</td><td>${result.maxLatency.toFixed(2)} ms</td><td><div class="bar" style="width: 100%"></div></td></tr>
    <tr><td>p50</td><td>${result.p50.toFixed(2)} ms</td><td><div class="bar" style="width: ${Math.min(100, result.p50 / result.maxLatency * 100)}%"></div></td></tr>
    <tr><td>p95</td><td>${result.p95.toFixed(2)} ms</td><td><div class="bar" style="width: ${Math.min(100, result.p95 / result.maxLatency * 100)}%"></div></td></tr>
    <tr><td>p99</td><td>${result.p99.toFixed(2)} ms</td><td><div class="bar" style="width: ${Math.min(100, result.p99 / result.maxLatency * 100)}%"></div></td></tr>
  </table>

  <p style="color: #888; margin-top: 30px; font-size: 12px;">
    Duration: ${result.duration.toFixed(1)}s | Timestamp: ${new Date(result.timestamp).toLocaleString()}
  </p>
</body>
</html>`;
}

function getCompareHtml(r1: BenchmarkResult, r2: BenchmarkResult): string {
  const compare = (v1: number, v2: number, lower = true) => {
    const diff = ((v2 - v1) / v1 * 100).toFixed(1);
    const better = lower ? v2 < v1 : v2 > v1;
    return `<span class="${better ? 'success' : 'error'}">${parseFloat(diff) > 0 ? '+' : ''}${diff}%</span>`;
  };

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; background: #1e1e1e; color: #fff; }
    h1 { color: #007acc; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: center; border-bottom: 1px solid #333; }
    th { color: #888; }
    .success { color: #4caf50; }
    .error { color: #f44336; }
    .url { font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <h1>Benchmark Comparison</h1>
  <table>
    <tr>
      <th>Metric</th>
      <th>Result 1<br><span class="url">${r1.url}</span></th>
      <th>Result 2<br><span class="url">${r2.url}</span></th>
      <th>Difference</th>
    </tr>
    <tr><td>Requests/sec</td><td>${r1.requestsPerSecond.toFixed(1)}</td><td>${r2.requestsPerSecond.toFixed(1)}</td><td>${compare(r1.requestsPerSecond, r2.requestsPerSecond, false)}</td></tr>
    <tr><td>Avg Latency</td><td>${r1.avgLatency.toFixed(1)} ms</td><td>${r2.avgLatency.toFixed(1)} ms</td><td>${compare(r1.avgLatency, r2.avgLatency)}</td></tr>
    <tr><td>p50</td><td>${r1.p50.toFixed(1)} ms</td><td>${r2.p50.toFixed(1)} ms</td><td>${compare(r1.p50, r2.p50)}</td></tr>
    <tr><td>p95</td><td>${r1.p95.toFixed(1)} ms</td><td>${r2.p95.toFixed(1)} ms</td><td>${compare(r1.p95, r2.p95)}</td></tr>
    <tr><td>p99</td><td>${r1.p99.toFixed(1)} ms</td><td>${r2.p99.toFixed(1)} ms</td><td>${compare(r1.p99, r2.p99)}</td></tr>
    <tr><td>Success Rate</td><td>${(r1.successfulRequests/r1.totalRequests*100).toFixed(1)}%</td><td>${(r2.successfulRequests/r2.totalRequests*100).toFixed(1)}%</td><td>${compare(r1.successfulRequests/r1.totalRequests, r2.successfulRequests/r2.totalRequests, false)}</td></tr>
  </table>
</body>
</html>`;
}

function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; background: #1e1e1e; color: #fff; text-align: center; }
    .error-icon { font-size: 60px; margin-bottom: 20px; }
    h2 { color: #f44336; }
  </style>
</head>
<body>
  <div class="error-icon">:(</div>
  <h2>Benchmark Failed</h2>
  <p>${message}</p>
</body>
</html>`;
}

class BenchmarkHistoryProvider implements vscode.TreeDataProvider<BenchmarkHistoryItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BenchmarkHistoryItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BenchmarkHistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): BenchmarkHistoryItem[] {
    return benchmarkHistory.map(r => new BenchmarkHistoryItem(r));
  }
}

class BenchmarkHistoryItem extends vscode.TreeItem {
  constructor(public readonly result: BenchmarkResult) {
    super(`${result.method} ${new URL(result.url).pathname}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${result.requestsPerSecond.toFixed(0)} req/s`;
    this.tooltip = `${result.url}\np99: ${result.p99.toFixed(0)}ms\n${new Date(result.timestamp).toLocaleString()}`;
  }
}

export function deactivate() {}
