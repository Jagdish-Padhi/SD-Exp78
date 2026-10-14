const express = require('express');

const app = express();
app.use(express.json());

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory_service:5001/reserve';

app.post('/book', async (req, res) => {
  const { user_id, seat_id } = req.body || {};

  if (!user_id || !seat_id) {
    return res.status(400).json({ error: 'Missing user_id or seat_id' });
  }

  try {
    const response = await fetch(INVENTORY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, seat_id }),
      signal: AbortSignal.timeout(5000)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(503).json({
      error: 'Inventory service unavailable',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Booking service listening on port ${PORT}`);
});
