# Experiment 6

## Aim:
- To demonstrate Distributed Locking in a Booking Scenario using Redis with a Microservices Decomposition (two microservices communicating over REST).
- A Booking Microservice accepts customer requests and calls an Inventory / Seat Reservation Microservice over REST. The Inventory Service uses Redis Distributed Locking to protect seat reservations (the single critical section) against concurrent double-booking.

---

## Theory :

### A. Microservices Decomposition and Inter-Service REST Communication
In a traditional monolithic booking system, order orchestration and seat inventory management share the same codebase, memory space, and runtime. By decomposing the application into microservices, these responsibilities are separated into two independent, loosely coupled services:

- **Booking Service (Service 1):** Acts as the user-facing API gateway that validates client inputs and orchestrates the reservation workflow by calling downstream services.
- **Inventory Service (Service 2):** Domain-level service that manages seat inventory state, validates seat availability, and handles the actual reservation logic.
- **REST Communication:** The Booking Service issues asynchronous HTTP `POST` requests to the Inventory Service's `/reserve` endpoint over the Docker network bridge.

### B. Need for Distributed Locking with Redis
In a containerized microservices environment, services run in separate processes and isolated containers. Conventional in-process concurrency primitives (e.g., in-memory mutexes, threading locks, or local locks) only synchronize operations within a single process. When concurrent requests hit independent microservices or processes simultaneously, local locks fail to prevent race conditions.

Redis-based distributed locking solves this problem by centralizing concurrency control:

- **Lock Acquisition:** Executed using the atomic Redis command:
  ```text
  SET lock:seat:101 <unique_token> NX PX 3000
  ```
  `NX` ensures the lock is only created if it doesn't already exist, and `PX 3000` sets an automatic Time-To-Live (TTL) of 3,000 milliseconds to avoid deadlock.
- **Critical Section:** Once the lock is acquired, the service validates seat status (checks if `AVAILABLE`), simulates processing delay (200 ms for database or payment processing), and commits the reservation.
- **Atomic Lock Release:** Released using a Redis Lua script:
  ```lua
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
  ```
  This ensures that a service only deletes the lock if it still holds ownership (its unique UUID token matches), preventing accidental deletion of a new lock acquired by another request after a timeout.
- **Lock Expiry Recovery:** If a service instance crashes during execution, the TTL expiration ensures Redis automatically evicts the abandoned lock key, permitting subsequent requests to proceed.

### C. Concurrent Reservation and Error Handling
When multiple client requests attempt to reserve the same seat simultaneously:
- **Successful Reservation (`200 OK`):** The first request acquires the lock, completes the critical section, and marks the seat as reserved.
- **Lock Contention / Locked Resource (`409 Conflict`):** Competing concurrent requests find the lock occupied (`SET NX` returns null), immediately failing fast without corrupting state.
- **Seat Already Reserved (`400 Bad Request`):** Subsequent requests after reservation completion detect that the seat is already booked.
- **Service Dependency Failure (`503 Service Unavailable`):** Returned by the API gateway if the downstream Inventory Service is unreachable.

### D. Lock Expiry and Recovery Testing
Lock expiry testing verifies that Redis automatically evicts a lock key when its TTL expires:
- A lock is created with a designated TTL.
- The existence and TTL countdown of the key are inspected in Redis.
- Once the TTL hits 0, the key is evicted, and another client can immediately acquire the lock.

---

### Component Summary Table

| Component | What it decides |
| :--- | :--- |
| **`Promise.all` Concurrent Test** | Dispatches multiple parallel HTTP requests to simulate high-concurrency traffic |
| **Booking Service (Gateway)** | Validates user input and routes booking requests downstream |
| **Redis Distributed Lock (`NX PX`)** | Restricts critical section entry to exactly one transaction at a time |
| **Atomic Lua Unlock Script** | Guarantees safe lock release without releasing other processes' locks |
| **Inventory State Store** | Persists seat allocation status and prevents double-booking |

---

## System Architecture

*(Draw your diagram in Excalidraw and insert the exported image here)*

> **[INSERT SCREENSHOT 1 HERE: System Architecture Diagram]**

### Architecture Description:
```text
[ Concurrent Clients (User 1 - 5) ]
                │
                │ HTTP POST /book (Port 5000)
                ▼
      ┌─────────────────────────┐
      │     Booking Service     │
      │  (Node.js REST Gateway) │
      └────────────┬────────────┘
                   │
                   │ HTTP POST /reserve (Port 5001)
                   ▼
      ┌─────────────────────────┐           ┌────────────────────────┐
      │    Inventory Service    │ ────────> │      Redis Server      │
      │   (Domain Controller)   │  SET NX   │ (Distributed Mutex +   │
      └─────────────────────────┘  LUA DEL  │  TTL Auto-expiration)  │
                                            └────────────────────────┘
```

---

## Project Directory

> **[INSERT SCREENSHOT 2 HERE: Project Directory Tree in VS Code / IDE Explorer]**

```text
SD-exp78/
├── booking_service/
│   ├── app.js
│   ├── package.json
│   └── Dockerfile
├── inventory_service/
│   ├── app.js
│   ├── package.json
│   └── Dockerfile
├── client_test.js
├── docker-compose.yml
├── package.json
└── README.md
```

---

## Docker Containers Status

Run `docker compose ps` in the terminal to inspect the active containers:

> **[INSERT SCREENSHOT 3 HERE: Terminal Output of `docker compose ps`]**

```text
NAME                               IMAGE                              COMMAND                  SERVICE             CREATED         STATUS         PORTS
sd-exp78-booking_service-1         sd-exp78-booking_service           "docker-entrypoint.s…"   booking_service     1 min ago       Up 1 min       0.0.0.0:5000->5000/tcp
sd-exp78-inventory_service-1       sd-exp78-inventory_service         "docker-entrypoint.s…"   inventory_service   1 min ago       Up 1 min       0.0.0.0:5001->5001/tcp
sd-exp78-redis-1                   redis:7-alpine                     "docker-entrypoint.s…"   redis               1 min ago       Up 1 min       0.0.0.0:6379->6379/tcp
```

---

## Source Code Implementation

### File 1: `booking_service/package.json`
```json
{
  "name": "booking-service",
  "version": "1.0.0",
  "description": "Booking Service REST API Gateway",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

### File 2: `booking_service/app.js`
**Service 1: Booking Service — Port 5000**
- Accepts incoming reservation requests via `POST /book`.
- Validates user payload (`user_id`, `seat_id`).
- Forwards requests to the Inventory Service via REST HTTP with timeout handling.

```javascript
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
```

### File 3: `booking_service/Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 5000
CMD ["node", "app.js"]
```

### File 4: `inventory_service/package.json`
```json
{
  "name": "inventory-service",
  "version": "1.0.0",
  "description": "Inventory & Seat Reservation Microservice with Redis Distributed Locking",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ioredis": "^5.4.1"
  }
}
```

### File 5: `inventory_service/app.js`
**Service 2: Inventory Service — Port 5001**
- Checks seat availability and guards reservation execution using Redis distributed locking.
- Acquires locks atomically using `SET NX PX`.
- Enforces safe release via a Lua script matching lock token ownership.

```javascript
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
```

### File 6: `inventory_service/Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 5001
CMD ["node", "app.js"]
```

### File 7: `docker-compose.yml`
```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  inventory_service:
    build:
      context: ./inventory_service
      dockerfile: Dockerfile
    ports:
      - "5001:5001"
    environment:
      - REDIS_HOST=redis
    depends_on:
      - redis

  booking_service:
    build:
      context: ./booking_service
      dockerfile: Dockerfile
    ports:
      - "5000:5000"
    environment:
      - INVENTORY_SERVICE_URL=http://inventory_service:5001/reserve
    depends_on:
      - inventory_service
```

### File 8: `client_test.js`
```javascript
const BOOKING_URL = 'http://localhost:5000/book';
const CONCURRENT_USERS = 5;
const SEAT_ID = 101;

async function bookSeat(userId) {
  try {
    const res = await fetch(BOOKING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, seat_id: SEAT_ID })
    });
    const data = await res.json();
    console.log(`[${userId}] Status: ${res.status} | Response:`, data);
  } catch (err) {
    console.error(`[${userId}] Error:`, err.message);
  }
}

async function runTest() {
  console.log(`=== Simulating ${CONCURRENT_USERS} Concurrent Requests for Seat ${SEAT_ID} ===`);

  const requests = Array.from({ length: CONCURRENT_USERS }, (_, idx) =>
    bookSeat(`User_${idx + 1}`)
  );

  await Promise.all(requests);
}

runTest();
```

---

## Output & Verification

### Test 1: Concurrent Reservation Test
Execute in terminal:
```bash
node client_test.js
```

> **[INSERT SCREENSHOT 4 HERE: Terminal Output of `node client_test.js`]**

```text
=== Simulating 5 Concurrent Requests for Seat 101 ===
[User_1] Status: 200 | Response: { success: true, message: 'Seat 101 successfully reserved for user User_1!' }
[User_2] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_3] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_4] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_5] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
```

### Test 2: Lock Contention Verification (Manual Redis Lock Injection)
Manually acquire the lock key in Redis with a 30-second TTL to simulate a busy critical section, then run the client test:
```bash
docker compose exec redis redis-cli SET lock:seat:101 test-owner NX PX 30000
node client_test.js
```

> **[INSERT SCREENSHOT 5 HERE: Terminal Output of Lock Contention Test]**

```text
OK
=== Simulating 5 Concurrent Requests for Seat 101 ===
[User_1] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_2] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_3] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_4] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
[User_5] Status: 409 | Response: { success: false, message: 'Seat 101 is currently locked by another transaction. Please retry.' }
```

### Test 3: Lock Expiry Recovery Verification
Verify that Redis automatically purges expired locks after the TTL:
```bash
docker compose exec redis redis-cli SET lock:seat:101 test-owner NX PX 3000
docker compose exec redis redis-cli EXISTS lock:seat:101
# (wait 4 seconds)
docker compose exec redis redis-cli EXISTS lock:seat:101
```

> **[INSERT SCREENSHOT 6 HERE: Terminal Output of Lock Expiry and Recovery Verification]**

```text
OK
(integer) 1
(integer) 0
```

---

## Observation :

| Observation Parameter | Monolithic / Without Distributed Lock | With Redis Distributed Lock |
| :--- | :--- | :--- |
| **Concurrency Coordination** | In-process thread locks only; fails across containers | Centralized distributed mutex in Redis accessible to all instances |
| **Race Condition Outcome** | High risk of duplicate seat bookings (double-booking) | Strictly mutual exclusion: exactly one booking succeeds |
| **Lock Handling Under Contention** | Multiple requests write to state concurrently | Competing requests fail fast with `409 Conflict` |
| **Fault Recovery Mechanism** | Process crash can cause deadlock | TTL (`PX 3000`) guarantees automated lock recovery |
| **Lock Release Safety** | Prone to releasing another request's lock | Lua script validates token ownership before `DEL` |

---

## Conclusion:
The seat reservation application successfully demonstrates **Microservices Decomposition** and **Redis-based Distributed Locking** implemented in Node.js and Docker. 

1. Decoupling the monolith into an edge **Booking Gateway Service** and a domain **Inventory Service** established clear separation of concerns with asynchronous REST communication.
2. Because local memory locks cannot coordinate across distributed containers, **Redis Distributed Locking (`SET NX PX`)** provided an atomic, centralized mutex protecting the critical reservation section.
3. Concurrency testing confirmed that among multiple simultaneous requests for Seat 101, exactly one request successfully acquired the lock and completed the reservation (`200 OK`), while all competing requests were safely rejected with `409 Conflict`, eliminating race conditions and double-booking.
4. Ownership-verified lock release via Lua scripts and automated TTL expiration proved resilient against deadlocks and accidental release bugs.
