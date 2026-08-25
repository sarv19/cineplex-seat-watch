import { readFile, writeFile } from "node:fs/promises";

const TICKETING_API = "https://apis.cineplex.com/prod/ticketing/api";
const THEATRICAL_API = "https://apis.cineplex.com/prod/cpx/theatrical/api";
const subscriptionKey = process.env.CINEPLEX_SUBSCRIPTION_KEY;
const dryRun = process.env.MONITOR_DRY_RUN === "true";

if (!subscriptionKey) {
  throw new Error("CINEPLEX_SUBSCRIPTION_KEY is required");
}

const config = JSON.parse(await readFile("showtimes.json", "utf8"));
const theatres = (
  config.theatres || [
    {
      id: config.theatreId,
      name: config.theatreName,
      shortName: config.theatreName,
    },
  ]
).map((t) => ({
  id: Number(t.id ?? t.theatreId),
  name: t.name ?? t.theatreName,
  shortName: t.shortName ?? t.name ?? t.theatreName ?? String(t.id ?? t.theatreId),
}));

const previousState = await readJson(".monitor-state.json", {
  availableByShowtime: {},
});
const seatMapCache = await readJson(".seat-map-cache.json", {});
const discoveryCache = await readJson(".discovery-cache.json", {
  scope: null,
  refreshedAt: null,
  lastQualifyingShowtimeStartsAt: null,
  showtimes: [],
});
const discoveryScope = JSON.stringify({
  theatres: theatres.map((t) => t.id).sort((a, b) => a - b),
  movieId: config.movieId,
  requiredExperienceTypes: [...config.requiredExperienceTypes].sort(),
});
const now = Date.now();
const allShowtimes = await getShowtimes();
const stopOffsetMs = config.stopCheckingMinutesBefore * 60_000;
const activeShowtimes = allShowtimes.filter(
  (showtime) => now < new Date(showtime.startsAt).getTime() - stopOffsetMs,
);

const checks = await mapWithConcurrency(activeShowtimes, 8, checkShowtime);
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
      theatreId: check.theatreId,
      theatreName: check.theatreName,
      theatreShortName: check.theatreShortName,
      label: check.label,
      url: check.url,
      seats: newlyAvailable,
      allAvailableSeats: check.available,
    });
  }

  nextAvailableByShowtime[check.id] = check.available;
}

const knownIds = new Set(activeShowtimes.map((showtime) => showtime.id));
for (const id of Object.keys(nextAvailableByShowtime)) {
  if (!knownIds.has(id)) delete nextAvailableByShowtime[id];
}
for (const id of Object.keys(seatMapCache)) {
  if (!knownIds.has(id)) delete seatMapCache[id];
}

const lastKnownStart = discoveryCache.lastQualifyingShowtimeStartsAt
  ? new Date(discoveryCache.lastQualifyingShowtimeStartsAt).getTime()
  : null;
const shutdownGraceMs = config.shutdownGraceDays * 24 * 60 * 60_000;
const shouldDisable =
  activeShowtimes.length === 0 &&
  lastKnownStart !== null &&
  now > lastKnownStart + shutdownGraceMs;

if (!dryRun) {
  await writeFile(
    ".monitor-state.json",
    `${JSON.stringify({ availableByShowtime: nextAvailableByShowtime }, null, 2)}\n`,
  );
}
await writeFile(".seat-map-cache.json", `${JSON.stringify(seatMapCache, null, 2)}\n`);
await writeFile(".discovery-cache.json", `${JSON.stringify(discoveryCache, null, 2)}\n`);
await writeFile(
  "alerts.json",
  `${JSON.stringify(
    {
      alerts,
      discoveredShowtimeCount: allShowtimes.length,
      activeShowtimeCount: activeShowtimes.length,
      checkedShowtimeCount: successfulChecks.length,
      shouldDisable,
      errors,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Discovered ${allShowtimes.length} qualifying showtimes across ${theatres.length} location(s). ` +
    `Checked ${successfulChecks.length}/${activeShowtimes.length} active showtimes; ` +
    `${alerts.length} new availability alert(s).`,
);

for (const error of errors) {
  console.error(`Showtime ${error.id}: ${error.error}`);
}

if (activeShowtimes.length > 0 && successfulChecks.length === 0) {
  process.exitCode = 1;
}

async function getShowtimes() {
  const refreshAfterMs = config.discoveryRefreshHours * 60 * 60_000;
  const refreshedAt = discoveryCache.refreshedAt
    ? new Date(discoveryCache.refreshedAt).getTime()
    : 0;
  const cacheIsFresh =
    discoveryCache.scope === discoveryScope &&
    discoveryCache.showtimes.length > 0 &&
    now - refreshedAt < refreshAfterMs;

  if (cacheIsFresh) return discoveryCache.showtimes;

  try {
    const discovered = await discoverShowtimes();
    const newestStart = discovered.reduce(
      (latest, showtime) =>
        !latest || new Date(showtime.startsAt) > new Date(latest)
          ? showtime.startsAt
          : latest,
      discoveryCache.scope === discoveryScope
        ? discoveryCache.lastQualifyingShowtimeStartsAt
        : null,
    );

    discoveryCache.scope = discoveryScope;
    discoveryCache.refreshedAt = new Date(now).toISOString();
    discoveryCache.lastQualifyingShowtimeStartsAt = newestStart;
    discoveryCache.showtimes = discovered;
    return discovered;
  } catch (error) {
    if (
      discoveryCache.scope === discoveryScope &&
      discoveryCache.showtimes.length > 0
    ) {
      console.error(`Showtime discovery failed; using cached list: ${error.message}`);
      return discoveryCache.showtimes;
    }
    throw error;
  }
}

async function discoverShowtimes() {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const discoveryStart = today.getTime() - 24 * 60 * 60_000;
  const horizon = today.getTime() + config.discoveryHorizonDays * 24 * 60 * 60_000;
  const discovered = [];

  for (const theatre of theatres) {
    try {
      const bookableDates = await fetchJson(
        `${THEATRICAL_API}/v1/dates/bookable?locationId=${theatre.id}`,
      );
      const dates = bookableDates
        .map((value) => String(value).slice(0, 10))
        .filter((date) => {
          const timestamp = new Date(`${date}T00:00:00Z`).getTime();
          return timestamp >= discoveryStart && timestamp <= horizon;
        });
      const dailyListings = await mapWithConcurrency(dates, 8, async (date) =>
        fetchJson(`${THEATRICAL_API}/v1/showtimes?locationId=${theatre.id}&date=${date}`),
      );

      for (const listing of dailyListings) {
        for (const t of listing ?? []) {
          if (Number(t.theatreId) !== Number(theatre.id)) continue;

          for (const day of t.dates ?? []) {
            for (const movie of day.movies ?? []) {
              if (
                Number(movie.id) !== Number(config.movieId) &&
                movie.name?.toLowerCase() !== config.movieName.toLowerCase()
              ) {
                continue;
              }

              for (const experience of movie.experiences ?? []) {
                const types = experience.experienceTypes ?? [];
                if (!config.requiredExperienceTypes.every((type) => types.includes(type))) {
                  continue;
                }

                for (const session of experience.sessions ?? []) {
                  if (
                    !session.isShowtimeEnabledOnline ||
                    !session.isReservedSeating ||
                    session.isInThePast
                  ) {
                    continue;
                  }

                  const id = String(session.vistaSessionId);
                  const startsAt = session.showStartDateTimeUtc;
                  discovered.push({
                    id,
                    theatreId: theatre.id,
                    theatreName: theatre.name,
                    theatreShortName: theatre.shortName,
                    label: formatShowtime(startsAt),
                    startsAt,
                    url:
                      `https://www.cineplex.com/ticketing/preview?locationId=${theatre.id}` +
                      `&showtimeId=${id}&dbox=false`,
                  });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`Discovery error for theatre ${theatre.name} (${theatre.id}): ${err.message}`);
    }
  }

  return [...new Map(discovered.map((showtime) => [showtime.id, showtime])).values()].sort(
    (a, b) => new Date(a.startsAt) - new Date(b.startsAt),
  );
}

async function checkShowtime(showtime) {
  try {
    const seatIds = await getSeatIds(showtime);
    const firstAvailability = await getAvailability(showtime);
    const firstAvailableSeats = availableWatchedSeats(firstAvailability, seatIds);

    if (firstAvailableSeats.length === 0) {
      return { ...showtime, available: [] };
    }

    await delay(5_000);
    const confirmation = await getAvailability(showtime);
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

  const theatreId = getShowtimeTheatreId(showtime);
  const layout = await fetchJson(
    `${TICKETING_API}/v1/theatre/${theatreId}/showtime/${showtime.id}/seat-layout`,
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

async function getAvailability(showtime) {
  const showtimeId = typeof showtime === "object" ? showtime.id : showtime;
  const theatreId = getShowtimeTheatreId(showtime);
  return fetchJson(
    `${TICKETING_API}/v1/theatre/${theatreId}/showtime/${showtimeId}/seat-availability?preview=true`,
  );
}

function getShowtimeTheatreId(showtime) {
  if (typeof showtime === "object") {
    if (showtime.theatreId) return showtime.theatreId;
    if (showtime.url) {
      const match = showtime.url.match(/locationId=(\d+)/);
      if (match) return match[1];
    }
  }
  const found = allShowtimes?.find((s) => String(s.id) === String(showtime?.id || showtime));
  if (found?.theatreId) return found.theatreId;
  return config.theatreId ?? theatres[0]?.id;
}

function availableWatchedSeats(availability, seatIds) {
  const statuses = availability.seatAvailabilities ?? {};
  return config.watchedSeats.filter(
    (seat) => String(statuses[seatIds[seat]]).toLowerCase() === "available",
  );
}

function formatShowtime(startsAt) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startsAt));
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
