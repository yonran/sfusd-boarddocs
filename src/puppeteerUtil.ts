import createDebug from 'debug';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
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

// https://stackoverflow.com/a/56011152/471341
export class RequestsWaiter {
    page: Page;
    onRequestBound: typeof RequestsWaiter.prototype.onRequest;
    onRequestFinishedBound: typeof RequestsWaiter.prototype.onRequestFinished;
    onRequestFailedBound: typeof RequestsWaiter.prototype.onRequestFailed;
    promise: Promise<void> | undefined;
    requests: HTTPRequest[];
    resolve: (() => void) | undefined;
    reject: ((err: Error) => void) | undefined;
    timer: NodeJS.Timer | undefined;
    name: string;
    // page.off doesn't seem to be working; just ignore any requests after closed
    closed: boolean;
    constructor(page: Page, name: string) {
        this.page = page;
        this.name = name;
        this.onRequestBound = this.onRequest.bind(this);
        this.onRequestFinishedBound = this.onRequestFinished.bind(this);
        this.onRequestFailedBound = this.onRequestFailed.bind(this);
        this.page.on('request', this.onRequestBound);
        this.page.on('requestfinished', this.onRequestFinishedBound);
        this.page.on('requestfailed', this.onRequestFailedBound);
        this.requests = [];
        this.closed = false;
    }
    onRequest(event: HTTPRequest) {
        if (this.closed) {
            return;
        }
        if (this.requests.indexOf(event) !== -1) {
            throw new Error('duplicate request ' + event.url());
        }
        this.requests.push(event);
        debug(
            this.name,
            'Detected request',
            event.method(),
            event.url(),
            event.postData(),
            this.requests.length
        );
    }
    private onRequestCompleted(event: HTTPRequest) {
        if (this.closed) {
            return;
        }
        const idx = this.requests.indexOf(event);
        if (idx !== -1) {
            this.requests.splice(idx, 1);
        }
        if (this.resolve !== undefined && this.requests.length === 0) {
            debug(this.name, 'finally resolving');
            this.resolve();
            this.close();
        }
    }
    onRequestFinished(event: HTTPRequest) {
        if (this.closed) {
            return;
        }
        debug(
            this.name,
            'Request completed',
            event.method(),
            event.url(),
            event.postData(),
            event.response()?.status,
            'remaining:',
            this.requests.length
        );
        this.onRequestCompleted(event);
    }
    onRequestFailed(event: HTTPRequest) {
        if (this.closed) {
            return;
        }
        debug(
            this.name,
            'Request failed',
            event.method(),
            event.url(),
            event.postData(),
            'remaining:',
            this.requests.length
        );
        this.onRequestCompleted(event);
    }
    async wait(timeout: number): Promise<void> {
        if (this.promise !== undefined) {
            throw new Error('wait should not be called multiple times');
        }
        if (this.closed) {
            throw new Error('already closed');
        }
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.timer = setTimeout(() => {
            this.reject!(new Error('timeout waiting for ' + this.requests.map((x) => x.url()).join(', ')));
            this.close();
        }, timeout);
        // wait for the click or whatever to be handled by the page first
        await this.page.evaluate(async () => {
            await Promise.resolve();
        });
        if (this.requests.length === 0) {
            debug(this.name, 'resolving right away; no requests left', this.requests.length);
            this.resolve!();
            this.close();
        }
        await this.promise;
        await this.page.evaluate(async () => {
            await Promise.resolve();
        });
    }
    close() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.page.off('requestfailed', this.onRequestFailedBound);
        this.page.off('requestfinished', this.onRequestFinishedBound);
        this.page.off('request', this.onRequestBound);
        this.closed = true;
    }
}
