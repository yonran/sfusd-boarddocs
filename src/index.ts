import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';

import createDebug from 'debug';
import * as t from 'io-ts';
import puppeteerCore from 'puppeteer-core';
import sleep from 'sleep-promise';
import yargs from 'yargs';

import {
    BrowserWrap,
    findExistingTabWithDomain,
    PageWrap,
    RequestsWaiter,
    RequestsWaiterOnce,
} from './puppeteerUtil.js';
import type { IItemManifest } from './types/ItemManifest.js';
import { ItemManifest } from './types/ItemManifest.js';
import type { IMeetingManifest } from './types/MeetingManifest.js';
import { MeetingManifest } from './types/MeetingManifest.js';
import { fileExists, parseFile, writeJson } from './util/fileUtil.js';

const debug = createDebug('boarddocs');
const MONTH_NAMES = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
] as const;
const TIMEOUT = 30000;

interface DateOnly {
    /** 4-digit year */
    year: number;
    /** 1-12 */
    month: number;
    /** 1-31 */
    date: number;
}
/** Return a number that can be sorted */
function daysSinceZero(date: DateOnly) {
    return Date.UTC(date.year, date.month - 1, date.date) / 3600;
}
/** yargs coerce function that converts YYYY-mm-dd string into a DateOnly */
function coerceDate(x: string | undefined): DateOnly | undefined {
    if (x === undefined) return undefined;
    const m = /(?<yyyy>\d{4})-(?<mm>\d{2})-(?<dd>\d{2})/.exec(x);
    if (m === null || m.groups === undefined) {
        throw new Error('--since did not match YYYY-mm-dd');
    }
    const year = +m.groups.yyyy;
    const month = +m.groups.mm;
    const date = +m.groups.dd;
    return { year, month, date };
}

async function main() {
    const args = yargs(process.argv.slice(2))
        .options({
            browserWSEndpoint: {
                description:
                    'The ws:// url that was printed when you run chrome --remote-debugging-port=9222',
                string: true,
                // demand: true,
            },
            query: {
                description: 'substring of the agenda item to filter on e.g. minutes',
                string: true,
            },
            download: {
                description: 'download attachments',
                type: 'boolean',
            },
            until: {
                description: 'max date to download',
                coerce: coerceDate,
            },
            since: {
                description: 'min date to download',
                coerce: coerceDate,
            },
        })
        .parseSync();
    const browserWrap =
        args.browserWSEndpoint == null
            ? new BrowserWrap(
                  await puppeteerCore.launch({
                      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                      headless: false,
                      defaultViewport: null,
                      slowMo: 100,
                  }),
                  true
              )
            : new BrowserWrap(
                  await puppeteerCore.connect({
                      browserWSEndpoint: args.browserWSEndpoint,
                      // set defaultViewport to null explicitly; don't change the viewport while attached
                      defaultViewport: null,
                      // slowMo: 100,
                  }),
                  false
              );
    debug('connected', browserWrap.browser.connected);
    const SFUSD_URL = 'https://go.boarddocs.com/ca/sfusd/Board.nsf/goto?open&id=BDLAAB25F17C';
    const pageWrap = new PageWrap(await findExistingTabWithDomain(browserWrap.browser, SFUSD_URL), false);
    try {
        const page = pageWrap.page;
        try {
            if (page.url() !== SFUSD_URL) {
                debug('navigating tab to', SFUSD_URL);
                await page.goto(SFUSD_URL);
            } else {
                debug('tab already at', SFUSD_URL);
            }

            debug('clicking meetings tab');
            await page.bringToFront(); // clicking etc. doesn't work unless the page is activated
            const requestsWaiter = new RequestsWaiterOnce(page, 'meetings');
            await page.click('a[href="#tab-meetings"]');
            await requestsWaiter.waitAndClose(TIMEOUT);
            const meetingYearHeaders = await page.$$(
                '#meetings > #meeting-accordion > section.ui-accordion-header > a'
            );
            const texts: string[] = await Promise.all(
                meetingYearHeaders.map((x) => x.evaluate((node: HTMLElement) => node.innerText.trim()))
            );
            debug('Meeting categories', texts);
            for (const [i, meetingYearHeader] of meetingYearHeaders.entries()) {
                const text = texts[i];
                if ('Featured' === text) {
                    continue; // skip the featured accordion which is just a subset of other ones
                }
                debug('clicking on meetings tab');
                await page.click('a[href="#tab-meetings"]');
                debug('clicking on meeting year');
                const requestsWaiter = new RequestsWaiterOnce(page, 'year');
                await meetingYearHeader.click();
                await requestsWaiter.waitAndClose(TIMEOUT);
                const meetingsInYearTabPanel = await meetingYearHeader.evaluateHandle(
                    (x: Element) => x.parentElement?.nextElementSibling
                );
                debug('meetingsInYearTabPanel', await meetingsInYearTabPanel.jsonValue());
                const meetingsInYear = await meetingsInYearTabPanel.asElement()!.$$(':scope > a');
                const meetingsInYearTexts: string[] = await Promise.all(
                    meetingsInYear.map((x) =>
                        x.evaluate((node: Element) => (node as HTMLElement).innerText.trim())
                    )
                );
                // debug('meetings in year:', text, meetingsInYearTexts);
                for (const [j, meetingLink] of meetingsInYear.entries()) {
                    const meetingTitle = meetingsInYearTexts[j];
                    const regexp = /(?<month>\w{3}) (?<date>\d{1,2}), (?<year>\d{4}) \(\w+\)\n?(?<type>.*)/;
                    const titleMatch = regexp.exec(meetingTitle);
                    if (titleMatch === null) {
                        throw Error(`Could not parse ${meetingTitle} using ${regexp}`);
                    }
                    const { month, date, year, type } = titleMatch.groups!;
                    const monthZeroIdx = (MONTH_NAMES as readonly string[]).indexOf(month);
                    const monthOneIdx = monthZeroIdx + 1;
                    const dateOnly: DateOnly = { year: +year, month: monthOneIdx, date: parseInt(date, 10) };
                    const Ymd = `${year}-${String(monthOneIdx).padStart(2, '0')}-${date.padStart(2, '0')}`;
                    const meetingSlug = `${Ymd}-${type.replace(/[^\w]+/g, '-').toLowerCase()}`;
                    const meetingManifestPath = path.join(meetingSlug, 'meeting.json');
                    if (args.until !== undefined && daysSinceZero(dateOnly) > daysSinceZero(args.until)) {
                        debug('skipping due to --until', meetingSlug);
                        continue;
                    } else if (
                        args.since !== undefined &&
                        daysSinceZero(dateOnly) < daysSinceZero(args.since)
                    ) {
                        debug('skipping due to --since', meetingSlug);
                        continue;
                    }

                    async function openMeetingTitlePage(): Promise<string | null> {
                        if (await meetingLink.isHidden()) {
                            debug('clicking meetings tab again');
                            await page.click('a[href="#tab-meetings"]');
                        }
                        if (await meetingLink.isHidden()) {
                            debug('clicking meeting year header again');
                            {
                                const requestsWaiter = new RequestsWaiterOnce(page, 'year');
                                await meetingYearHeader.click();
                                await sleep(500);
                                await requestsWaiter.waitAndClose(TIMEOUT);
                            }
                        }
                        debug('clicking on meeting', meetingTitle);

                        const requestsWaiter = new RequestsWaiterOnce(page, 'meeting');
                        await meetingLink.click();
                        await sleep(500);
                        await requestsWaiter.waitAndClose(TIMEOUT);

                        // The content panel goes blank while it loads; wait for the share link to show up
                        await page.waitForSelector('#pane-content-meetings button.url');
                        const meetingUrl = await page.$eval('#pane-content-meetings button.url', (x) =>
                            x.getAttribute('data-clipboard-text')
                        );
                        return meetingUrl;
                    }
                    let didOpenMeetingAgenda = false;
                    async function openMeetingAgenda(isTitlePageOpen: boolean): Promise<void> {
                        if (didOpenMeetingAgenda) {
                            return;
                        }
                        didOpenMeetingAgenda = true;
                        if (!isTitlePageOpen) {
                            await openMeetingTitlePage();
                        }
                        const agendaButton = await page.$('a#btn-view-agenda');
                        if (agendaButton !== null) {
                            debug('clicking agenda for', meetingSlug);
                            const requestsWaiter = new RequestsWaiterOnce(page, 'agenda');
                            await agendaButton.click();
                            await sleep(500);
                            await requestsWaiter.waitAndClose(TIMEOUT);
                        } else {
                            throw Error('Could not find agenda button for ' + meetingSlug);
                        }
                    }

                    let meetingManifest: IMeetingManifest | undefined = undefined;
                    if (await fileExists(meetingManifestPath)) {
                        meetingManifest = await parseFile(meetingManifestPath, MeetingManifest);
                        debug('read meeting manifest', meetingManifestPath);
                        if (!meetingManifest.categories.some((x) => x.items.length > 0)) {
                            debug(
                                'reloading meeting since all the items are null; it must have been scraped previously with incorrect item selector'
                            );
                            meetingManifest = undefined;
                        }
                    }
                    if (meetingManifest === undefined) {
                        const meetingUrl = await openMeetingTitlePage();
                        await openMeetingAgenda(true);

                        const agendaCategories = await page.$$eval('#agenda > .wrap-category', (els) =>
                            els.map((el) => {
                                const category: HTMLElement = el as HTMLElement;
                                return {
                                    categoryId: category
                                        .querySelector(':scope > .category')
                                        ?.getAttribute('unique'),
                                    categoryOrder: category
                                        .querySelector<HTMLElement>(':scope > .category > span.order')
                                        ?.innerText.trim()
                                        .replace(/\.$/, ''),
                                    categoryName: category.querySelector<HTMLElement>(
                                        ':scope > .category > .category-name'
                                    )?.innerText,
                                };
                            })
                        );
                        const categoriesWithItems = [];
                        for (const category of agendaCategories) {
                            const items = await page.$$eval(
                                `#agenda > .wrap-category > .category[unique="${category.categoryId}"] + .wrap-items > li.item`,
                                (els) =>
                                    els.map((el) => {
                                        const div = el as HTMLElement;
                                        // Each item is identified by 12 uppercase alphanumeric characters
                                        const itemId = div.getAttribute('unique');
                                        const itemOrder = (
                                            div.querySelector(':scope > span.order') as HTMLElement
                                        ).innerText;
                                        const itemName = (
                                            div.querySelector(':scope > span.title') as HTMLElement
                                        ).innerText;
                                        const itemSlug = `${itemOrder}-${itemId}-${itemName}`
                                            .substring(0, 64)
                                            .trim()
                                            .replace(/[^\w]+/g, '-')
                                            .toLowerCase();
                                        return {
                                            itemId,
                                            itemOrder,
                                            itemName,
                                            itemSlug,
                                        };
                                    })
                            );
                            categoriesWithItems.push({ ...category, items });
                        }
                        meetingManifest = {
                            date: Ymd,
                            meetingSlug,
                            meetingType: type,
                            meetingUrl,
                            categories: categoriesWithItems,
                        };
                        debug('writing meeting json', JSON.stringify(meetingManifest, undefined, 2));
                        await writeJson(meetingManifestPath, meetingManifest, t.exact(MeetingManifest));
                    }

                    for (const category of meetingManifest.categories) {
                        const requestsWaiter = new RequestsWaiter(page, 'item');
                        try {
                            for (const agendaItem of category.items) {
                                const { itemId, itemOrder, itemName } = agendaItem;
                                const itemSlug = agendaItem.itemSlug;
                                let item: IItemManifest | undefined;
                                const itemJsonPath = path.join(meetingSlug, itemSlug, 'item.json');

                                if (
                                    args.query !== undefined &&
                                    !itemName.toLowerCase().includes(args.query.toLowerCase())
                                ) {
                                    debug('skipping agenda item that does not match query', itemName);
                                    continue;
                                }

                                let didOpenItem = false;
                                async function openItem() {
                                    if (didOpenItem) {
                                        return;
                                    }
                                    didOpenItem = true;
                                    await openMeetingAgenda(false);
                                    // find the item again to avoid Error: Node is detached from document
                                    const itemLinkSelector = `#agenda > .wrap-category > .wrap-items > li.item[unique="${itemId}"]`;
                                    debug(
                                        'clicking on item link',
                                        Ymd,
                                        category.categoryOrder,
                                        itemOrder,
                                        itemName,
                                        itemLinkSelector
                                    );
                                    // the link does not reliably load the item content on the first click
                                    // so just click a few times
                                    const selector = `#agenda-content input[name=agenda-item-unique][value="${itemId}"]`;
                                    let n = 0;
                                    while (true) {
                                        await sleep(500);
                                        await requestsWaiter.wait(TIMEOUT);
                                        await (await page.$(itemLinkSelector))?.scrollIntoView();
                                        await page.click(itemLinkSelector);
                                        await requestsWaiter.wait(TIMEOUT);
                                        try {
                                            debug(`waiting for ${selector}`);
                                            await page.waitForSelector(selector, { timeout: 1000 * (n + 1) });
                                            // apparently waiting for the input is not sufficient; the rest of the item still needs to load
                                            await page.waitForSelector('#agenda-content button.url', {
                                                timeout: 1000 * (n + 1),
                                            });
                                            break;
                                        } catch (e) {
                                            if (
                                                (e as puppeteerCore.TimeoutError).name === 'TimeoutError' &&
                                                n < 5
                                            ) {
                                                debug('retrying click on item link', e);
                                                await sleep(500);
                                            } else {
                                                debug('unknown error or too many timeouts; rethrowing');
                                                throw e;
                                            }
                                        }
                                        n++;
                                    }
                                }
                                if (await fileExists(itemJsonPath)) {
                                    item = await parseFile(itemJsonPath, ItemManifest);
                                    debug('read items json', itemJsonPath);
                                }
                                if (item === undefined || item.innerHtml === undefined) {
                                    await openItem();
                                    const itemUrl = await page.$eval('#agenda-content button.url', (x) =>
                                        x.getAttribute('data-clipboard-text')
                                    );
                                    const innerHtml = await page.$eval(
                                        '#view-agenda-item',
                                        (x) => x.innerHTML
                                    );
                                    const links = await page.$$eval(
                                        '#agenda-content a.public-file',
                                        (els: Element[]) =>
                                            els.map((el) => {
                                                const a = el as HTMLAnchorElement;
                                                return {
                                                    order: a.getAttribute('order')?.trim().replace(/\.$/, ''),
                                                    unique: a.getAttribute('unique'),
                                                    href: a.href,
                                                    text: a.innerText,
                                                    filename: decodeURIComponent(
                                                        new URL(a.href).pathname
                                                    ).replace(/.*\//, ''),
                                                };
                                            })
                                    );
                                    item = {
                                        ...agendaItem,
                                        itemUrl,
                                        links,
                                        innerHtml,
                                    };
                                    debug('writing items json', itemJsonPath);
                                    await writeJson(itemJsonPath, item, t.exact(ItemManifest));
                                }

                                if (item.links.length > 0 && args.download) {
                                    for (const link of item.links) {
                                        const p = path.join(meetingSlug, agendaItem.itemSlug, link.filename);
                                        if (await fileExists(p)) {
                                            debug('File already exists; skipping', p);
                                        } else {
                                            await openItem();
                                            debug('writing attachment', p, 'from', link.href);
                                            await fsPromises.mkdir(path.dirname(p), { recursive: true });
                                            const resp = await fetch(link.href);
                                            await fsPromises.writeFile(
                                                p,
                                                Readable.fromWeb(resp.body! as ReadableStream<Uint8Array>)
                                            );
                                        }
                                    }
                                    // break outer;
                                }
                            }
                        } finally {
                            requestsWaiter.close();
                        }
                    }
                    // const viewMinutesLink = await page.$('a.btn-view-minutes')
                    // if (null !== viewMinutesLink) {
                    //     debug('clicking on view minutes for meeting');
                    //     await viewMinutesLink.click();
                    //     await (await page.$('div#generic-dialog a'))?.click();
                    //     break outer;
                    // }
                }
            }
        } finally {
            await pageWrap.close();
        }
    } finally {
        await browserWrap.close();
    }
}
main().catch((err) => {
    console.error('unexpected error', err);
});
