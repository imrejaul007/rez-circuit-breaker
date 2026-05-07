import express from 'express';

const app = express();
app.use(express.json());

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
  name: string;
  state: CircuitState;
  failures: number;
  lastFailure: Date | null;
  threshold: number;
  timeout: number;
}

const circuits = new Map<string, CircuitBreaker>();

function createBreaker(name: string, threshold = 5, timeout = 60000): CircuitBreaker {
  return {
    name,
    state: 'CLOSED',
    failures: 0,
    lastFailure: null,
    threshold,
    timeout
  };
}

function getBreaker(name: string): CircuitBreaker {
  if (!circuits.has(name)) {
    circuits.set(name, createBreaker(name));
  }
  return circuits.get(name)!;
}

function recordSuccess(name: string) {
  const cb = getBreaker(name);
  cb.failures = 0;
  cb.state = 'CLOSED';
}

function recordFailure(name: string) {
  const cb = getBreaker(name);
  cb.failures++;
  cb.lastFailure = new Date();
  if (cb.failures >= cb.threshold) {
    cb.state = 'OPEN';
  }
}

function canExecute(name: string): boolean {
  const cb = getBreaker(name);
  if (cb.state === 'CLOSED') return true;
  if (cb.state === 'OPEN') {
    const elapsed = Date.now() - (cb.lastFailure?.getTime() || 0);
    if (elapsed > cb.timeout) {
      cb.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }
  return true; // HALF_OPEN
}

// API endpoints
app.post('/success/:name', (req, res) => {
  recordSuccess(req.params.name);
  res.json({ success: true, circuit: getBreaker(req.params.name) });
});

app.post('/failure/:name', (req, res) => {
  recordFailure(req.params.name);
  const cb = getBreaker(req.params.name);
  res.json({ 
    failure: true, 
    circuit: cb,
    canExecute: canExecute(req.params.name)
  });
});

app.get('/state/:name', (req, res) => {
  const cb = getBreaker(req.params.name);
  res.json({ 
    ...cb,
    canExecute: canExecute(req.params.name)
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    circuits: Array.from(circuits.values())
  });
});

app.post('/reset/:name', (req, res) => {
  circuits.set(req.params.name, createBreaker(req.params.name));
  res.json({ reset: true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Circuit breaker running on ${PORT}`));
