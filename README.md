# Cineplex seat watch

This repository checks 21 public Cineplex seat-preview pages every five minutes
for seats F7–F23 and G7–G13. It creates an assigned GitHub issue when a watched
seat becomes newly available, including the showtime and direct booking link.

The monitor uses Cineplex's public ticketing data endpoint. A possible
availability result is fetched twice, five seconds apart, before an alert is
created. It never selects, holds, signs in, or purchases tickets.

The workflow automatically stops after the final monitored showtime on
September 16, 2026.
