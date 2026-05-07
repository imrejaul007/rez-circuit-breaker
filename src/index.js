const express = require('express');
const app = express();
app.use(express.json());

const circuits = new Map();

function getBreaker(name) {
  if (!circuits.has(name)) {
    circuits.set(name, { name, state: 'CLOSED', failures: 0, lastFailure: null, threshold: 5, timeout: 60000 });
  }
  return circuits.get(name);
}

app.post('/failure/:name', (req, res) => {
  const cb = getBreaker(req.params.name);
  cb.failures++;
  cb.lastFailure = new Date();
  if (cb.failures >= cb.threshold) cb.state = 'OPEN';
  res.json({ failure: true, circuit: cb });
});

app.get('/state/:name', (req, res) => {
  res.json(getBreaker(req.params.name));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', circuits: Array.from(circuits.values()) });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log('Circuit Breaker running on', PORT));
