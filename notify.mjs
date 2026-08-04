import { readFile, appendFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const assignee = process.env.ALERT_ASSIGNEE;

if (!token || !repository) {
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
}

const result = JSON.parse(await readFile("alerts.json", "utf8"));

if (result.alerts.length > 0) {
  const title =
    result.alerts.length === 1
      ? `Cineplex seats available — ${result.alerts[0].label}: ${result.alerts[0].seats.join(", ")}`
      : `Cineplex seats available in ${result.alerts.length} showtimes`;
  const sections = result.alerts.map((alert) =>
    [
      `### ${alert.label}`,
      "",
      `- **Newly available:** ${alert.seats.join(", ")}`,
      `- **All watched seats currently available:** ${alert.allAvailableSeats.join(", ")}`,
      `- [Open Cineplex and book now](${alert.url})`,
    ].join("\n"),
  );
  const body = [
    "## Watched Cineplex seats are available",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "This monitor does not select, hold, or purchase seats.",
  ].join("\n");

  const response = await fetch(`https://api.github.com/repos/${repository}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      body,
      ...(assignee ? { assignees: [assignee] } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub issue creation failed: ${response.status} ${await response.text()}`);
  }

  const issue = await response.json();
  console.log(`Created alert: ${issue.html_url}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `Discovered ${result.discoveredShowtimeCount} qualifying showtimes. ` +
      `Checked ${result.checkedShowtimeCount} active showtimes. ` +
      `Created ${result.alerts.length} alert(s).\n`,
  );
}
