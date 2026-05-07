/**
 * Express Middleware for Circuit Breaker Pattern
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerOptions,
  CircuitBreakerOpenError,
  CircuitBreakerMetrics,
  globalRegistry
} from './circuit-breaker';

/**
 * Extended Express Request with circuit breaker metadata
 */
export interface CircuitBreakerRequest extends Request {
  circuitBreaker?: {
    name: string;
    metrics: CircuitBreakerMetrics;
  };
}

/**
 * Middleware options
 */
export interface BreakerMiddlewareOptions {
  name: string;
  options?: CircuitBreakerOptions;
  fallbackStatusCode?: number;
  fallbackMessage?: string;
  includeMetricsHeader?: boolean;
  skip?: (req: Request) => boolean;
}

/**
 * Create circuit breaker middleware
 *
 * Usage:
 *   const breakerMiddleware = createBreakerMiddleware({
 *     name: 'external-api',
 *     options: { failureThreshold: 3, timeout: 5000 },
 *     fallbackStatusCode: 503
 *   });
 *
 *   app.use('/api/external', breakerMiddleware, externalRouter);
 */
export function createBreakerMiddleware(options: BreakerMiddlewareOptions): RequestHandler {
  const {
    name,
    fallbackStatusCode = 503,
    fallbackMessage = 'Service temporarily unavailable',
    includeMetricsHeader = true,
    skip
  } = options;

  const breaker = globalRegistry.get(name, options.options);

  return (req: CircuitBreakerRequest, res: Response, next: NextFunction): void => {
    // Check skip condition
    if (skip && skip(req)) {
      return next();
    }

    // Attach circuit breaker info to request
    req.circuitBreaker = {
      name,
      metrics: breaker.getMetrics()
    };

    // Set metrics header if enabled
    if (includeMetricsHeader) {
      res.setHeader('X-Circuit-Breaker', name);
      res.setHeader('X-Circuit-State', breaker.getState());
    }

    // Check if circuit is open
    if (breaker.isOpen()) {
      const metrics = breaker.getMetrics();

      if (includeMetricsHeader) {
        res.setHeader('X-Circuit-Consecutive-Failures', metrics.consecutiveFailures.toString());
      }

      res.status(fallbackStatusCode);
      res.json({
        error: 'Service Unavailable',
        message: fallbackMessage,
        circuitBreaker: {
          name,
          state: CircuitState.OPEN,
          retryAfter: Math.max(0, metrics.consecutiveFailures)
        }
      });
      return;
    }

    next();
  };
}

/**
 * Wrapper for protected route handlers
 *
 * Usage:
 *   app.get('/users/:id',
 *     withCircuitBreaker('user-service', { failureThreshold: 5 }),
 *     async (req, res) => {
 *       const user = await fetchUser(req.params.id);
 *       res.json(user);
 *     }
 *   );
 */
export function withCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  name: string,
  options?: CircuitBreakerOptions
): (handler: T) => RequestHandler {
  const breaker = globalRegistry.get(name, options);

  return (handler: T): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Set circuit breaker headers
        res.setHeader('X-Circuit-Breaker', name);
        res.setHeader('X-Circuit-State', breaker.getState());

        const result = await breaker.execute(() => handler(req, res, next));

        // If handler returned a value (not void), send it
        if (result !== undefined) {
          res.json(result);
        }
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          res.status(503);
          res.json({
            error: 'Service Unavailable',
            message: 'Circuit breaker is open',
            circuitBreaker: {
              name: error.circuitState,
              state: error.circuitState,
              metrics: error.metrics
            }
          });
          return;
        }
        next(error);
      }
    };
  };
}

/**
 * Express Router wrapper with integrated circuit breaker
 *
 * Usage:
 *   const protectedRouter = createProtectedRouter('external-api', {
 *     failureThreshold: 3,
 *     timeout: 5000
 *   });
 *
 *   protectedRouter.get('/data', asyncHandler);
 *   app.use('/api', protectedRouter);
 */
export function createProtectedRouter(
  name: string,
  options?: CircuitBreakerOptions
): { router: ReturnType<typeof import('express').Router>; breaker: CircuitBreaker } {
  // This is a dynamic import to avoid circular dependencies
  const express = require('express');
  const router = express.Router();
  const breaker = globalRegistry.get(name, options);

  // Middleware to check circuit state
  router.use((req: CircuitBreakerRequest, res: Response, next: NextFunction) => {
    req.circuitBreaker = {
      name,
      metrics: breaker.getMetrics()
    };
    res.setHeader('X-Circuit-Breaker', name);
    res.setHeader('X-Circuit-State', breaker.getState());

    if (breaker.isOpen()) {
      res.status(503);
      res.json({
        error: 'Service Unavailable',
        message: 'Circuit breaker is open',
        circuitBreaker: name
      });
      return;
    }
    next();
  });

  return { router, breaker };
}

/**
 * Async route handler wrapper with circuit breaker
 *
 * Usage:
 *   app.post('/api/data',
 *     asyncHandler(async (req, res) => {
 *       const result = await breaker.execute(() => processData(req.body));
 *       res.status(201).json(result);
 *     }, 'data-processor')
 *   );
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  breakerName?: string
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Express error handler for circuit breaker errors
 */
export function circuitBreakerErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof CircuitBreakerOpenError) {
    res.status(503);
    res.json({
      error: 'Circuit Breaker Open',
      message: err.message,
      circuitBreaker: {
        state: err.circuitState,
        metrics: err.metrics
      }
    });
    return;
  }
  next(err);
}

/**
 * Health check endpoint handler for circuit breakers
 *
 * Usage:
 *   app.get('/health/breakers', circuitBreakerHealthCheck);
 */
export function circuitBreakerHealthCheck(req: Request, res: Response): void {
  const states = globalRegistry.getAllStates();
  const metrics = globalRegistry.getAllMetrics();

  const allHealthy = Object.values(states).every(
    state => state === CircuitState.CLOSED
  );

  const status = allHealthy ? 'healthy' : 'degraded';

  res.status(allHealthy ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    circuits: Object.fromEntries(
      Object.entries(metrics).map(([name, m]) => [name, {
        state: m.state,
        isHealthy: m.state === CircuitState.CLOSED,
        failures: m.totalFailures,
        successes: m.totalSuccesses,
        consecutiveFailures: m.consecutiveFailures
      }])
    )
  });
}

/**
 * Dashboard endpoint for circuit breaker status
 *
 * Usage:
 *   app.get('/admin/breakers', circuitBreakerDashboard);
 */
export function circuitBreakerDashboard(req: Request, res: Response): void {
  const states = globalRegistry.getAllStates();
  const metrics = globalRegistry.getAllMetrics();

  res.json({
    title: 'Circuit Breaker Dashboard',
    timestamp: new Date().toISOString(),
    summary: {
      total: Object.keys(states).length,
      closed: Object.values(states).filter(s => s === CircuitState.CLOSED).length,
      open: Object.values(states).filter(s => s === CircuitState.OPEN).length,
      halfOpen: Object.values(states).filter(s => s === CircuitState.HALF_OPEN).length
    },
    circuits: Object.entries(metrics).map(([name, m]) => ({
      name,
      state: m.state,
      status: m.state === CircuitState.CLOSED ? 'healthy' : m.state === CircuitState.OPEN ? 'tripped' : 'testing',
      metrics: {
        totalRequests: m.totalRequests,
        totalFailures: m.totalFailures,
        totalSuccesses: m.totalSuccesses,
        successRate: m.totalRequests > 0
          ? ((m.totalSuccesses / m.totalRequests) * 100).toFixed(2) + '%'
          : 'N/A',
        consecutiveFailures: m.consecutiveFailures,
        consecutiveSuccesses: m.consecutiveSuccesses,
        lastFailureTime: m.lastFailureTime ? new Date(m.lastFailureTime).toISOString() : null,
        lastSuccessTime: m.lastSuccessTime ? new Date(m.lastSuccessTime).toISOString() : null
      }
    }))
  });
}

/**
 * Middleware to expose circuit breaker state to templates/views
 */
export function circuitBreakerLocals(
  req: CircuitBreakerRequest,
  res: Response,
  next: NextFunction
): void {
  res.locals.circuitBreaker = req.circuitBreaker || null;
  res.locals.breakerStates = globalRegistry.getAllStates();
  next();
}

export default {
  createBreakerMiddleware,
  withCircuitBreaker,
  createProtectedRouter,
  asyncHandler,
  circuitBreakerErrorHandler,
  circuitBreakerHealthCheck,
  circuitBreakerDashboard,
  circuitBreakerLocals
};
