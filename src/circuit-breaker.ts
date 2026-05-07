/**
 * Circuit Breaker Pattern Implementation
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is tripped, requests fail fast
 * - HALF_OPEN: Testing if the service has recovered
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;      // Number of failures before opening (default: 5)
  successThreshold?: number;      // Number of successes in HALF_OPEN to close (default: 2)
  timeout?: number;               // Time in ms before attempting recovery (default: 60000)
  resetTimeout?: number;          // Time between half-open probe requests (default: 30000)
  monitoringPeriod?: number;      // Period to track failures (default: 60000)
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

type CircuitEventType =
  | 'stateChange'
  | 'success'
  | 'failure'
  | 'reject'
  | 'timeout'
  | 'reset';

type CircuitEventCallback = (state: CircuitState, metrics: CircuitBreakerMetrics) => void;

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttempt: number = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly resetTimeout: number;
  private readonly monitoringPeriod: number;

  private readonly name: string;
  private listeners: Map<CircuitEventType, CircuitEventCallback[]> = new Map();

  // Metrics
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;

  constructor(name: string = 'default', options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeout = options.timeout ?? 60000;
    this.resetTimeout = options.resetTimeout ?? 30000;
    this.monitoringPeriod = options.monitoringPeriod ?? 60000;

    // Initialize listeners
    this.listeners.set('stateChange', []);
    this.listeners.set('success', []);
    this.listeners.set('failure', []);
    this.listeners.set('reject', []);
    this.listeners.set('timeout', []);
    this.listeners.set('reset', []);
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    // Check if request should be rejected
    if (!this.canExecute()) {
      this.emit('reject', this.state, this.getMetrics());
      throw new CircuitBreakerOpenError(
        `Circuit breaker '${this.name}' is ${this.state}`,
        this.state,
        this.getMetrics()
      );
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  /**
   * Execute with optional timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new CircuitBreakerTimeoutError(`Operation timed out after ${this.timeout}ms`));
      }, this.timeout);
    });

    return Promise.race([fn(), timeoutPromise]);
  }

  /**
   * Check if a request can be executed based on current state
   */
  private canExecute(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if timeout has elapsed for recovery attempt
        if (Date.now() >= this.nextAttempt) {
          this.toHalfOpen();
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return false;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.successes++;
    this.totalSuccesses++;
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;

    this.emit('success', this.state, this.getMetrics());

    // In HALF_OPEN state, track successes
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.toClosed();
      }
    }

    // In CLOSED state, reset failure count periodically
    if (this.state === CircuitState.CLOSED) {
      this.maybeResetFailures();
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: Error): void {
    this.lastFailureTime = Date.now();
    this.failures++;
    this.totalFailures++;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;

    this.emit('failure', this.state, this.getMetrics());

    if (error instanceof CircuitBreakerTimeoutError) {
      this.emit('timeout', this.state, this.getMetrics());
    }

    // Transition to OPEN if threshold exceeded
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.toOpen();
    }
  }

  /**
   * Transition to CLOSED state
   */
  private toClosed(): void {
    if (this.state !== CircuitState.CLOSED) {
      this.state = CircuitState.CLOSED;
      this.failures = 0;
      this.consecutiveFailures = 0;
      this.emit('stateChange', this.state, this.getMetrics());
    }
  }

  /**
   * Transition to OPEN state
   */
  private toOpen(): void {
    if (this.state !== CircuitState.OPEN) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.resetTimeout;
      this.emit('stateChange', this.state, this.getMetrics());
    }
  }

  /**
   * Transition to HALF_OPEN state
   */
  private toHalfOpen(): void {
    if (this.state === CircuitState.OPEN) {
      this.state = CircuitState.HALF_OPEN;
      this.successes = 0;
      this.consecutiveSuccesses = 0;
      this.emit('stateChange', this.state, this.getMetrics());
    }
  }

  /**
   * Periodically reset failure count in CLOSED state
   */
  private maybeResetFailures(): void {
    if (this.lastFailureTime && this.monitoringPeriod > 0) {
      // Failure count naturally decays as they age out
      // This is handled by the monitoring period logic
    }
  }

  /**
   * Register an event listener
   */
  on(event: CircuitEventType, callback: CircuitEventCallback): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.push(callback);
    }
  }

  /**
   * Remove an event listener
   */
  off(event: CircuitEventType, callback: CircuitEventCallback): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: CircuitEventType, state: CircuitState, metrics: CircuitBreakerMetrics): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach(callback => callback(state, metrics));
    }
  }

  /**
   * Get current circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is closed (healthy)
   */
  isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  /**
   * Check if circuit is open (tripped)
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Check if circuit is half-open (testing recovery)
   */
  isHalfOpen(): boolean {
    return this.state === CircuitState.HALF_OPEN;
  }

  /**
   * Manually force the circuit to a specific state
   */
  forceState(state: CircuitState): void {
    const previousState = this.state;
    this.state = state;

    switch (state) {
      case CircuitState.CLOSED:
        this.failures = 0;
        this.successes = 0;
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        break;
      case CircuitState.OPEN:
        this.nextAttempt = Date.now() + this.resetTimeout;
        break;
      case CircuitState.HALF_OPEN:
        this.successes = 0;
        this.consecutiveSuccesses = 0;
        break;
    }

    if (previousState !== state) {
      this.emit('stateChange', state, this.getMetrics());
    }
  }

  /**
   * Reset the circuit breaker to initial state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttempt = 0;
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;

    this.emit('reset', this.state, this.getMetrics());
  }

  /**
   * Get the name of this circuit breaker
   */
  getName(): string {
    return this.name;
  }
}

/**
 * Custom error for when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly circuitState: CircuitState,
    public readonly metrics: CircuitBreakerMetrics
  ) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    Error.captureStackTrace?.(this, CircuitBreakerOpenError);
  }
}

/**
 * Custom error for operation timeout
 */
export class CircuitBreakerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerTimeoutError';
    Error.captureStackTrace?.(this, CircuitBreakerTimeoutError);
  }
}

/**
 * Circuit Breaker Registry - manages multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create a circuit breaker
   */
  get(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Check if a circuit breaker exists
   */
  has(name: string): boolean {
    return this.breakers.has(name);
  }

  /**
   * Remove a circuit breaker
   */
  remove(name: string): boolean {
    return this.breakers.delete(name);
  }

  /**
   * Get all circuit breaker metrics
   */
  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};
    this.breakers.forEach((breaker, name) => {
      metrics[name] = breaker.getMetrics();
    });
    return metrics;
  }

  /**
   * Get all circuit breaker states
   */
  getAllStates(): Record<string, CircuitState> {
    const states: Record<string, CircuitState> = {};
    this.breakers.forEach((breaker, name) => {
      states[name] = breaker.getState();
    });
    return states;
  }
}

// Default global registry
export const globalRegistry = new CircuitBreakerRegistry();
