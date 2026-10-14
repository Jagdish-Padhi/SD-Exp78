const express = require('express');
const Redis = require('ioredis');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const redis = new Redis({
  host: REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 100, 3000)
});

const seats = {
  '101': { status: 'AVAILABLE', price: 100 }
};

const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function acquireLock(key, token, ttlMs = 3000) {
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function releaseLock(key, token) {
  try {
    await redis.eval(UNLOCK_SCRIPT, 1, key, token);
  } catch (err) {
    console.error(`Failed to release lock for ${key}:`, err.message);
  }
}

app.post('/reserve', async (req, res) => {
  const { user_id, seat_id } = req.body || {};
  const seatKey = String(seat_id);

  if (!seats[seatKey]) {
    return res.status(400).json({ success: false, message: 'Invalid Seat ID' });
  }

  const lockKey = `lock:seat:${seatKey}`;
  const lockToken = crypto.randomUUID();

  const locked = await acquireLock(lockKey, lockToken, 3000);
  if (!locked) {
    return res.status(409).json({
      success: false,
      message: `Seat ${seatKey} is currently locked by another transaction. Please retry.`
    });
  }

  try {
    // Simulate real-world I/O delay (db write or payment checkout)
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (seats[seatKey].status === 'RESERVED') {
      return res.status(400).json({
        success: false,
        message: `Seat ${seatKey} is ALREADY RESERVED!`
      });
    }

    seats[seatKey].status = 'RESERVED';
    seats[seatKey].booked_by = user_id;

    return res.status(200).json({
      success: true,
      message: `Seat ${seatKey} successfully reserved for user ${user_id}!`
    });
  } finally {
    await releaseLock(lockKey, lockToken);
  }
});

app.get('/seats', (req, res) => {
  res.json(seats);
});

app.post('/reset', async (req, res) => {
  seats['101'] = { status: 'AVAILABLE', price: 100 };
  await redis.del('lock:seat:101');
  res.json({ success: true, message: 'Seat 101 reset to AVAILABLE' });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Inventory service listening on port ${PORT}`);
});
