Downloads attachments (e.g. meeting minutes) from boarddocs.com

## Usage

On one tab, open Chrome with `--remote-debugging-port=9222` e.g.

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --user-data-dir=$HOME/Library/Application\ Support/Google/Chrome
```

Copy the url “DevTools listening on ws://127.0.0.1:9222/devtools/browser/…”

On the other tab, run the scraper:

```sh
npm run scrape -- --browserWSEndpoint=ws://…
```
