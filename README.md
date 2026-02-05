# APIBench VSCode Extension

Run API benchmarks directly from VS Code with visual results and comparison tools.

## Features

- **Run Benchmarks**: Benchmark any HTTP endpoint with configurable duration and connections
- **Quick Test**: Fast 5-second benchmark with a single command
- **Visual Results**: Beautiful dashboard with latency charts and metrics
- **History**: Track and review past benchmark results
- **Compare**: Side-by-side comparison of benchmark results

## Commands

- `APIBench: Run Benchmark` - Full benchmark with custom settings
- `APIBench: Quick Test URL` - Quick 5-second benchmark
- `APIBench: Show History` - View past benchmark results
- `APIBench: Compare Results` - Compare two benchmark results

## Metrics

- Requests per second (throughput)
- Latency: average, min, max
- Percentiles: p50, p95, p99
- Success rate

## Configuration

```json
{
  "apibench.defaultDuration": 10,
  "apibench.defaultConnections": 10,
  "apibench.saveHistory": true
}
```

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press F5 in VSCode to test

## License

MIT
