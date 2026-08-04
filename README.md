# Cineplex seat watch

This repository discovers every online, reserved-seat showing of *The Odyssey*
in IMAX 70MM at Cineplex Cinemas Mississauga Square One. It checks seats F7–F23
and G7–G13 approximately every five minutes and creates an assigned GitHub issue
when a watched seat becomes newly available.

The qualifying showtime list is refreshed from Cineplex every six hours, so newly
added showtimes are included automatically. Multiple availability hits from one
check are grouped into one issue to avoid notification spam.

The monitor uses Cineplex's public read-only ticketing data. A possible
availability result is fetched twice, five seconds apart, before an alert is
created. It never selects, holds, signs in, or purchases tickets.

After the final discovered showing passes, the workflow keeps checking for one
week in case Cineplex adds more dates, then disables itself.
