import createDebug from 'debug';
import type { Browser, Page } from 'puppeteer-core';
import { URL } from 'url';

const debug = createDebug('boarddocs');

export class BrowserWrap {
    constructor(readonly browser: Browser, readonly shouldClose: boolean) {}
    async close(): Promise<void> {
        if (this.shouldClose) {
            debug('browser.close');
            await this.browser.close();
        } else {
            debug('browser.disconnect');
            this.browser.disconnect();
        }
    }
}

export class PageWrap {
    constructor(readonly page: Page, readonly shouldClose: boolean) {}
    async close(): Promise<void> {
        if (this.shouldClose) {
            debug('closing page');
            await this.page.close();
        }
    }
}

export async function findExistingTabWithDomain(browser: Browser, urlString: string): Promise<Page> {
    const url = new URL(urlString);
    url.pathname = '/';
    url.search = '';
    const existingPages = await browser.pages();
    // TODO: find activated tab with boarddocs, not just last tab.
    const existingPage = existingPages
        .filter((page) => {
            const ok = page.url().startsWith(url.toString());
            if (!ok) {
                // debug('skipping page with url', page.url(), 'vs', url.toString());
            }
            return ok;
        })
        .pop();
    const page = existingPage === undefined ? await browser.newPage() : existingPage;
    return page;
}
