import { readFile, writeFile } from "node:fs/promises";

const API_BASE = "https://apis.cineplex.com/prod/ticketing/api";
const subscriptionKey = process.env.CINEPLEX_SUBSCRIPTION_KEY;

if (!subscriptionKey) {
  throw new Error("CINEPLEX_SUBSCRIPTION_KEY is required");
}

const config = JSON.parse(await readFile("showtimes.json", "utf8"));
const previousState = await readJson(".monitor-state.json", {
  availableByShowtime: {},
});
const seatMapCache = await readJson(".seat-map-cache.json", {});
const now = Date.now();
const stopOffsetMs = config.stopCheckingMinutesBefore * 60_000;
const activeShowtimes = config.showtimes.filter(
  (showtime) => now < new Date(showtime.startsAt).getTime() - stopOffsetMs,
);

const checks = await mapWithConcurrency(activeShowtimes, 4, checkShowtime);
const successfulChecks = checks.filter((check) => !check.error);
const errors = checks.filter((check) => check.error);
const nextAvailableByShowtime = { ...previousState.availableByShowtime };
const alerts = [];

for (const check of successfulChecks) {
  const before = previousState.availableByShowtime[check.id] ?? [];
  const newlyAvailable = check.available.filter((seat) => !before.includes(seat));

  if (newlyAvailable.length > 0) {
    alerts.push({
      id: check.id,
      label: check.label,
      url: check.url,
      seats: newlyAvailable,
      allAvailableSeats: check.available,
    });
  }

  nextAvailableByShowtime[check.id] = check.available;
}

for (const showtime of config.showtimes) {
  if (!activeShowtimes.some((active) => active.id === showtime.id)) {
    delete nextAvailableByShowtime[showtime.id];
  }
}

await writeFile(
  ".monitor-state.json",
  `${JSON.stringify({ availableByShowtime: nextAvailableByShowtime }, null, 2)}\n`,
);
await writeFile(".seat-map-cache.json", `${JSON.stringify(seatMapCache, null, 2)}\n`);
await writeFile(
  "alerts.json",
  `${JSON.stringify(
    {
      alerts,
      activeShowtimeCount: activeShowtimes.length,
      checkedShowtimeCount: successfulChecks.length,
      allExpired: activeShowtimes.length === 0,
      errors,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Checked ${successfulChecks.length}/${activeShowtimes.length} active showtimes; ` +
    `${alerts.length} new availability alert(s).`,
);

for (const error of errors) {
  console.error(`Showtime ${error.id}: ${error.error}`);
}

if (activeShowtimes.length > 0 && successfulChecks.length === 0) {
  process.exitCode = 1;
}

async function checkShowtime(showtime) {
  try {
    const seatIds = await getSeatIds(showtime);
    const firstAvailability = await getAvailability(showtime.id);
    const firstAvailableSeats = availableWatchedSeats(firstAvailability, seatIds);

    if (firstAvailableSeats.length === 0) {
      return { ...showtime, available: [] };
    }

    await delay(5_000);
    const confirmation = await getAvailability(showtime.id);
    const confirmedSeats = availableWatchedSeats(confirmation, seatIds).filter((seat) =>
      firstAvailableSeats.includes(seat),
    );

    return { ...showtime, available: confirmedSeats };
  } catch (error) {
    return { ...showtime, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getSeatIds(showtime) {
  const cached = seatMapCache[showtime.id];
  if (cached && config.watchedSeats.every((seat) => cached[seat])) {
    return cached;
  }

  const layout = await fetchJson(
    `${API_BASE}/v1/theatre/${config.theatreId}/showtime/${showtime.id}/seat-layout`,
  );
  const seatsByLabel = {};
  collectSeats(layout, seatsByLabel);

  const watchedSeatIds = Object.fromEntries(
    config.watchedSeats.map((seat) => [seat, seatsByLabel[seat]]),
  );
  const missing = config.watchedSeats.filter((seat) => !watchedSeatIds[seat]);

  if (missing.length > 0) {
    throw new Error(`seat layout is missing: ${missing.join(", ")}`);
  }

  seatMapCache[showtime.id] = watchedSeatIds;
  return watchedSeatIds;
}

async function getAvailability(showtimeId) {
  return fetchJson(
    `${API_BASE}/v1/theatre/${config.theatreId}/showtime/${showtimeId}/seat-availability?preview=true`,
  );
}

function availableWatchedSeats(availability, seatIds) {
  const statuses = availability.seatAvailabilities ?? {};
  return config.watchedSeats.filter(
    (seat) => String(statuses[seatIds[seat]]).toLowerCase() === "available",
  );
}

function collectSeats(value, result) {
  if (Array.isArray(value)) {
    for (const item of value) collectSeats(item, result);
    return;
  }

  if (!value || typeof value !== "object") return;

  if (typeof value.id === "string" && typeof value.label === "string") {
    result[value.label] = value.id;
  }

  for (const child of Object.values(value)) collectSeats(child, result);
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Ocp-Apim-Subscription-Key": subscriptionKey,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(1_000 * attempt);
    }
  }

  throw lastError;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
