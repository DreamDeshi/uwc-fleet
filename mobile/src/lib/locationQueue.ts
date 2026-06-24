import AsyncStorage from "@react-native-async-storage/async-storage";

// A durable, offline-first buffer for GPS readings (Brief §7: "AsyncStorage
// queue for location posts ... flush on reconnect"). Points are appended every
// 30s while a trip is active; when the network is up they're flushed to the API
// and the queue is cleared. Because it lives in AsyncStorage, a queued point
// survives the app being backgrounded or killed mid-trip.

export interface QueuedPoint {
  trip_id: string;
  latitude: number;
  longitude: number;
  recorded_at: string; // ISO — captured at GPS-read time, preserved through the queue
}

const QUEUE_KEY = "uwc.locationQueue";

// The server accepts at most 500 points per POST, so we cap the buffer there
// too. If the driver is offline for hours we keep the most RECENT 500 readings
// (newest positions matter most) and drop the oldest.
const MAX_QUEUE = 500;

async function readQueue(): Promise<QueuedPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPoint[]) : [];
  } catch {
    return []; // corrupt JSON — start clean rather than crash the tracker
  }
}

async function writeQueue(points: QueuedPoint[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(points));
}

export async function enqueueLocation(point: QueuedPoint): Promise<void> {
  const queue = await readQueue();
  queue.push(point);
  const trimmed = queue.length > MAX_QUEUE ? queue.slice(queue.length - MAX_QUEUE) : queue;
  await writeQueue(trimmed);
}

export async function getQueuedLocations(): Promise<QueuedPoint[]> {
  return readQueue();
}

export async function getQueuedCount(): Promise<number> {
  return (await readQueue()).length;
}

// Remove a set of already-sent points by identity (trip + timestamp). We remove
// exactly what we flushed rather than clearing everything, so any readings added
// DURING the network round-trip aren't accidentally dropped.
export async function removeLocations(sent: QueuedPoint[]): Promise<void> {
  if (sent.length === 0) return;
  const sentKeys = new Set(sent.map((p) => `${p.trip_id}|${p.recorded_at}`));
  const remaining = (await readQueue()).filter(
    (p) => !sentKeys.has(`${p.trip_id}|${p.recorded_at}`)
  );
  await writeQueue(remaining);
}
