Downloads attachments (e.g. meeting minutes) from boarddocs.com

## Usage

The scraper talks directly to BoardDocs' internal JSON/HTML API (no browser needed):

```sh
npm run scrape -- --since=2017-01-01 --download
```

Options:

- `--since=YYYY-mm-dd` / `--until=YYYY-mm-dd`: limit the date range of meetings to fetch.
- `--download`: also download attachments.
- `--query=<substring>`: only process agenda items whose title contains the substring.
