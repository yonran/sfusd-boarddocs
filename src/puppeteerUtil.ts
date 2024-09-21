import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

import createDebug from 'debug';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';

const debug = createDebug('boarddocs');

export class BrowserWrap {
    constructor(
        readonly browser: Browser,
        readonly shouldClose: boolean
    ) {}
    async close(): Promise<void> {
        if (this.shouldClose) {
            debug('browser.close');
            await this.browser.close();
        } else {
            debug('browser.disconnect');
            await this.browser.disconnect();
        }
    }
}

export class PageWrap {
    constructor(
        readonly page: Page,
        readonly shouldClose: boolean
    ) {}
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
    debug('looking for tab with url', url.toString());
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
    let page: Page;
    if (existingPage === undefined) {
        debug('no existing tab found; creating new tab');
        page = await browser.newPage();
    } else {
        debug('found existing tab');
        page = existingPage;
    }
    return page;
}

export class RequestsWaiterTimeout extends Error {
    constructor(message: string) {
        super(message);
    }
}
// https://stackoverflow.com/a/56011152/471341
export class RequestsWaiter {
    onRequestBound: typeof RequestsWaiter.prototype.onRequest;
    onRequestFinishedBound: typeof RequestsWaiter.prototype.onRequestFinished;
    onRequestFailedBound: typeof RequestsWaiter.prototype.onRequestFailed;
    requests: HTTPRequest[] = [];
    resolves: (() => void)[] = [];
    timer: NodeJS.Timeout | undefined;
    // page.off doesn't seem to be working; just ignore any requests after closed
    closed: boolean = false;
    constructor(
        readonly page: Page,
        readonly name: string
    ) {
        this.onRequestBound = this.onRequest.bind(this);
        this.onRequestFinishedBound = this.onRequestFinished.bind(this);
        this.onRequestFailedBound = this.onRequestFailed.bind(this);
        this.page.on('request', this.onRequestBound);
        this.page.on('requestfinished', this.onRequestFinishedBound);
        this.page.on('requestfailed', this.onRequestFailedBound);
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
        if (this.requests.length === 0 && this.resolves.length > 0) {
            debug(this.name, 'finally resolving');
            this.resolves.forEach((resolve) => resolve());
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
            event.response()?.status(),
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
            event.response()?.status(),
            'remaining:',
            this.requests.length
        );
        this.onRequestCompleted(event);
    }
    async wait(timeout: number): Promise<void> {
        if (this.closed) {
            throw new Error('already closed');
        }
        let resolve: () => void, reject: (err: Error) => void;
        const promise = new Promise<void>((myresolve, myreject) => {
            resolve = myresolve;
            reject = myreject;
        });
        this.timer = setTimeout(() => {
            reject!(
                new RequestsWaiterTimeout(
                    'timeout waiting for ' + this.requests.map((x) => x.url()).join(', ')
                )
            );
        }, timeout);
        // wait for the click or whatever to be handled by the page first
        await this.page.evaluate(async () => {
            await Promise.resolve();
        });
        if (this.requests.length === 0) {
            debug(this.name, 'resolving right away; no requests left', this.requests.length);
            resolve!();
        } else {
            this.resolves.push(resolve!);
        }
        await promise;
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
export class RequestsWaiterOnce {
    #requestsWaiter: RequestsWaiter;
    #isStarted: boolean = false;
    constructor(
        readonly page: Page,
        readonly name: string
    ) {
        this.#requestsWaiter = new RequestsWaiter(page, name);
    }
    async waitAndClose(timeout: number): Promise<void> {
        if (this.#isStarted) {
            throw new Error('wait should not be called multiple times');
        }
        this.#isStarted = true;
        try {
            await this.#requestsWaiter.wait(timeout);
        } finally {
            this.#requestsWaiter.close();
        }
    }
}
