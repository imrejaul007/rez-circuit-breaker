# REZ-circuit-breaker

Circuit breaker pattern implementation for Node.js/Express applications.

## Overview

This library implements the circuit breaker pattern to prevent cascading failures and improve system resilience. It monitors service health and automatically "trips" the circuit when failure thresholds are exceeded.

## States

| State | Description |
|-------|-------------|
| **CLOSED** | Normal operation - requests pass through |
| **OPEN** | Circuit tripped - requests fail fast |
| **HALF_OPEN** | Testing recovery - limited requests allowed |

## Installation

```bash
npm install
```

## Development

```bash
# Build TypeScript
npm run build

# Run development server
npm run dev

# Run production server
npm start
```

## Usage

### Basic Circuit Breaker

```typescript
import { CircuitBreaker, CircuitState } from './circuit-breaker';

const breaker = new CircuitBreaker('my-service', {
  failureThreshold: 5,      // Open after 5 consecutive failures
  successThreshold: 2,      // Close after 2 successes in HALF_OPEN
  timeout: 60000,           // 60 seconds before attempting recovery
  resetTimeout: 30000       // 30 seconds between recovery attempts
});

async function fetchData() {
  try {
    const result = await breaker.execute(async () => {
      const response = await fetch('https://api.example.com/data');
      return response.json();
    });
    return result;
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      // Handle circuit open state
      return getCachedData();
    }
    throw error;
  }
}
```

### Express Middleware

```typescript
import express from 'express';
import { createBreakerMiddleware, withCircuitBreaker } from './breaker.middleware';

const app = express();

// Option 1: Middleware-based protection
app.get('/api/data',
  createBreakerMiddleware({
    name: 'external-api',
    options: { failureThreshold: 3, timeout: 5000 },
    fallbackStatusCode: 503
  }),
  (req, res) => {
    res.json({ data: '...' });
  }
);

// Option 2: Handler wrapper
app.get('/api/users/:id',
  withCircuitBreaker('user-service', { failureThreshold: 5 }),
  async (req, res) => {
    const user = await fetchUser(req.params.id);
    res.json(user);
  }
);
```

### Event Listeners

```typescript
import { CircuitBreaker, CircuitState } from './circuit-breaker';

const breaker = new CircuitBreaker('my-service');

breaker.on('stateChange', (state, metrics) => {
  console.log(`Circuit ${state}:`, metrics);
});

breaker.on('failure', (state, metrics) => {
  console.log(`Failure #${metrics.consecutiveFailures}`);
});

breaker.on('success', (state, metrics) => {
  console.log(`Success! Total: ${metrics.totalSuccesses}`);
});
```

### Metrics

```typescript
const metrics = breaker.getMetrics();

console.log({
  state: metrics.state,           // Current circuit state
  failures: metrics.failures,     // Failures in current window
  successes: metrics.successes,    // Successes in current window
  totalRequests: metrics.totalRequests,
  totalFailures: metrics.totalFailures,
  consecutiveFailures: metrics.consecutiveFailures,
  lastFailureTime: metrics.lastFailureTime
});
```

### Circuit Breaker Registry

```typescript
import { globalRegistry } from './circuit-breaker';

// Get or create a circuit breaker
const breaker = globalRegistry.get('my-service', { failureThreshold: 3 });

// Check if exists
if (globalRegistry.has('my-service')) {
  // ...
}

// Get all states
const allStates = globalRegistry.getAllStates();
const allMetrics = globalRegistry.getAllMetrics();
```

## API Endpoints (Demo Server)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/health/breakers` | GET | Circuit breaker health status |
| `/admin/breakers` | GET | Circuit breaker dashboard |
| `/api/external` | GET | Protected external API example |
| `/api/users/:id` | GET | Protected user service example |
| `/api/batch` | POST | Protected batch processing example |
| `/api/breaker/:name/status` | GET | Get breaker status |
| `/api/breaker/:name/reset` | POST | Reset breaker state |
| `/api/breaker/:name/state` | POST | Force breaker state |

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `failureThreshold` | 5 | Failures before opening circuit |
| `successThreshold` | 2 | Successes in HALF_OPEN to close |
| `timeout` | 60000 | Operation timeout in ms |
| `resetTimeout` | 30000 | Time before recovery attempt |
| `monitoringPeriod` | 60000 | Period for failure tracking |

## Response Headers

All protected endpoints include:

- `X-Circuit-Breaker`: Circuit name
- `X-Circuit-State`: Current state (CLOSED/OPEN/HALF_OPEN)
- `X-Circuit-Consecutive-Failures`: Failure count (when open)

## Error Responses

When circuit is OPEN (HTTP 503):

```json
{
  "error": "Service Unavailable",
  "message": "Circuit breaker is open",
  "circuitBreaker": {
    "name": "my-service",
    "state": "OPEN",
    "metrics": { ... }
  }
}
```

## License

MIT
