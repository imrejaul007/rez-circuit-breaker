import express, { Request, Response } from 'express';
import {
  createBreakerMiddleware,
  withCircuitBreaker,
  circuitBreakerErrorHandler,
  circuitBreakerHealthCheck,
  circuitBreakerDashboard,
  circuitBreakerLocals
} from './breaker.middleware';
import { globalRegistry, CircuitState } from './circuit-breaker';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Add circuit breaker locals to all requests
app.use(circuitBreakerLocals);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Circuit breaker management endpoints
app.get('/health/breakers', circuitBreakerHealthCheck);
app.get('/admin/breakers', circuitBreakerDashboard);

// Example protected endpoint using middleware
app.get(
  '/api/external',
  createBreakerMiddleware({
    name: 'external-api',
    options: { failureThreshold: 3, timeout: 5000 }
  }),
  (req: Request, res: Response) => {
    // Simulated external API call
    const shouldFail = Math.random() > 0.7;

    if (shouldFail) {
      throw new Error('External API temporarily unavailable');
    }

    res.json({
      data: 'External API response',
      timestamp: new Date().toISOString()
    });
  }
);

// Example protected endpoint using wrapper
app.get(
  '/api/users/:id',
  withCircuitBreaker('user-service', { failureThreshold: 5, timeout: 3000 }),
  async (req: Request, res: Response) => {
    const userId = req.params.id;

    // Simulated user service call
    const shouldFail = Math.random() > 0.8;

    if (shouldFail) {
      throw new Error('User service error');
    }

    res.json({
      id: userId,
      name: `User ${userId}`,
      email: `user${userId}@example.com`
    });
  }
);

// Example batch endpoint with circuit breaker
app.post(
  '/api/batch',
  createBreakerMiddleware({
    name: 'batch-service',
    options: { failureThreshold: 2, timeout: 10000 }
  }),
  async (req: Request, res: Response) => {
    const { items } = req.body;

    // Simulated batch processing
    const shouldFail = Math.random() > 0.75;

    if (shouldFail) {
      throw new Error('Batch processing failed');
    }

    res.json({
      processed: items?.length || 0,
      results: (items || []).map((item: any) => ({
        ...item,
        status: 'completed'
      }))
    });
  }
);

// Circuit breaker status for specific service
app.get('/api/breaker/:name/status', (req: Request, res: Response) => {
  const { name } = req.params;
  const breaker = globalRegistry.get(name);

  res.json({
    name,
    ...breaker.getMetrics()
  });
});

// Manual circuit breaker control (for testing/admin)
app.post('/api/breaker/:name/reset', (req: Request, res: Response) => {
  const { name } = req.params;
  const breaker = globalRegistry.get(name);

  breaker.reset();

  res.json({
    message: `Circuit breaker '${name}' has been reset`,
    state: breaker.getState()
  });
});

app.post('/api/breaker/:name/state', (req: Request, res: Response) => {
  const { name } = req.params;
  const { state } = req.body;
  const breaker = globalRegistry.get(name);

  if (!Object.values(CircuitState).includes(state)) {
    res.status(400).json({
      error: 'Invalid state',
      validStates: Object.values(CircuitState)
    });
    return;
  }

  breaker.forceState(state);

  res.json({
    message: `Circuit breaker '${name}' forced to ${state}`,
    state: breaker.getState()
  });
});

// Error handling
app.use(circuitBreakerErrorHandler);

app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error('Error:', err.message);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Circuit Breaker Demo Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Breaker health: http://localhost:${PORT}/health/breakers`);
  console.log(`Breaker dashboard: http://localhost:${PORT}/admin/breakers`);
});

export default app;
