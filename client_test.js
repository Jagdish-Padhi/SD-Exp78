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
