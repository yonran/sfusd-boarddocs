import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';

import * as cheerio from 'cheerio';
import createDebug from 'debug';
import * as t from 'io-ts';
import sleep from 'sleep-promise';
import yargs from 'yargs';

import type { IItemManifest } from './types/ItemManifest.js';
import { ItemManifest } from './types/ItemManifest.js';
import type { IMeetingCategory, IMeetingItem } from './types/MeetingManifest.js';
import type { IMeetingManifest } from './types/MeetingManifest.js';
import { MeetingManifest } from './types/MeetingManifest.js';
import { fileExists, parseFile, writeJson } from './util/fileUtil.js';

const debug = createDebug('boarddocs');

const APP_PATH = 'ca/sfusd/Board.nsf';
const BASE_URL = `https://go.boarddocs.com/${APP_PATH}`;
const COMMITTEE_ID = 'A4EP6J588C05';
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// polite delay between requests to the BoardDocs server
const REQUEST_DELAY_MS = 800;
// CloudFront's WAF rate-limits sustained scraping with a blanket 403 (even on plain GETs) that
// only clears after a cooldown; back off hard and retry rather than burning through the rest of
// the meeting list as instant failures.
const RATE_LIMIT_RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const resp = await fetch(input, init);
        if (resp.status !== 403 || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) {
            return resp;
        }
        const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        console.error(
            `got HTTP 403 (likely rate-limited); waiting ${delayMs / 1000}s before retrying`,
            input
        );
        await sleep(delayMs);
    }
}

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

/** POST to a BoardDocs `BD-*` Domino agent endpoint and return the raw response body. */
async function bdPost(agent: string, data: Record<string, string>): Promise<string> {
    await sleep(REQUEST_DELAY_MS);
    const body = new URLSearchParams({ ...data, current_committee_id: COMMITTEE_ID });
    const url = `${BASE_URL}/${agent}?open&${Math.random()}`;
    debug('POST', url, body.toString());
    const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: `${BASE_URL}/goto?open&id=BDLAAB25F17C`,
        },
        body: body.toString(),
    });
    if (!resp.ok) {
        throw new Error(`${agent} failed: HTTP ${resp.status}`);
    }
    return resp.text();
}

interface RawMeeting {
    unique: string;
    unid: string;
    name: string;
    numberdate: string;
    current: string;
}
/** Fetch the full meeting list for the committee in one call. */
async function getMeetingsList(): Promise<RawMeeting[]> {
    const text = await bdPost('BD-GetMeetingsList', {});
    const data = JSON.parse(text) as Partial<RawMeeting>[];
    return data.filter(
        (x): x is RawMeeting => typeof x.unique === 'string' && typeof x.numberdate === 'string'
    );
}

/** Fetch and parse the agenda (categories + items) for a meeting. */
async function getAgendaCategories(meetingId: string): Promise<IMeetingCategory[]> {
    const html = await bdPost('BD-GetAgenda', { id: meetingId });
    const $ = cheerio.load(`<div id="root">${html}</div>`);
    const categories: IMeetingCategory[] = [];
    let current: IMeetingCategory | undefined;
    $('#root')
        .children()
        .each((_i, el) => {
            const $el = $(el);
            if ($el.is('dl.wrap-category')) {
                const dt = $el.find('dt.category').first();
                current = {
                    categoryId: dt.attr('unique') ?? null,
                    categoryOrder: dt.find('span.order').first().text().trim().replace(/\.$/, ''),
                    categoryName: dt.find('span.category-name').first().text().trim(),
                    items: [],
                };
                categories.push(current);
            } else if ($el.is('li.item')) {
                if (current === undefined) {
                    throw new Error('agenda item appeared before any category');
                }
                const itemId = $el.attr('unique') ?? null;
                const itemOrder = $el.find('span.order').first().text().trim();
                const itemName = $el.find('span.title').first().text().trim();
                const itemSlug = `${itemOrder}-${itemId}-${itemName}`
                    .substring(0, 64)
                    .trim()
                    .replace(/[^\w]+/g, '-')
                    .toLowerCase();
                const item: IMeetingItem = { itemId, itemOrder, itemName, itemSlug };
                current.items.push(item);
            }
        });
    return categories;
}

/** Fetch and parse the detail (HTML content + attachments) for a single agenda item. */
async function getItemDetail(itemId: string): Promise<{ innerHtml: string; links: IItemManifest['links'] }> {
    const [itemHtml, filesHtml] = await Promise.all([
        bdPost('BD-GetAgendaItem', { id: itemId }),
        bdPost('BD-GetPublicFiles', { id: itemId }),
    ]);
    const $item = cheerio.load(itemHtml);
    const innerHtml = $item('#view-agenda-item').html() ?? '';

    const $files = cheerio.load(`<div id="root">${filesHtml}</div>`);
    const links = $files('a.public-file')
        .map((_i, el) => {
            const $a = $files(el);
            const href = $a.attr('href') ?? '';
            const absoluteHref = href.startsWith('http') ? href : new URL(href, BASE_URL).toString();
            return {
                order: $a.attr('order')?.trim().replace(/\.$/, ''),
                unique: $a.attr('unique') ?? null,
                href: absoluteHref,
                text: $a.text(),
                filename: decodeURIComponent(new URL(absoluteHref).pathname).replace(/.*\//, ''),
            };
        })
        .get();
    return { innerHtml, links };
}

async function main() {
    const args = yargs(process.argv.slice(2))
        .options({
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

    debug('fetching meetings list');
    const meetings = await getMeetingsList();
    debug('found', meetings.length, 'meetings');

    for (const meeting of meetings) {
        const numberdate = meeting.numberdate;
        const dateOnly: DateOnly = {
            year: +numberdate.slice(0, 4),
            month: +numberdate.slice(4, 6),
            date: +numberdate.slice(6, 8),
        };
        const Ymd = `${numberdate.slice(0, 4)}-${numberdate.slice(4, 6)}-${numberdate.slice(6, 8)}`;
        const type = meeting.name;
        const meetingSlug = `${Ymd}-${type.replace(/[^\w]+/g, '-').toLowerCase()}`;
        const meetingManifestPath = path.join(meetingSlug, 'meeting.json');

        if (args.until !== undefined && daysSinceZero(dateOnly) > daysSinceZero(args.until)) {
            debug('skipping due to --until', meetingSlug);
            continue;
        } else if (args.since !== undefined && daysSinceZero(dateOnly) < daysSinceZero(args.since)) {
            debug('skipping due to --since', meetingSlug);
            continue;
        }

        let meetingManifest: IMeetingManifest | undefined = undefined;
        if (await fileExists(meetingManifestPath)) {
            meetingManifest = await parseFile(meetingManifestPath, MeetingManifest);
            debug('read meeting manifest', meetingManifestPath);
            if (!meetingManifest.categories.some((x) => x.items.length > 0)) {
                debug('reloading meeting since all the items are null');
                meetingManifest = undefined;
            }
        }
        if (meetingManifest === undefined) {
            debug('fetching agenda for', meetingSlug);
            const categories = await getAgendaCategories(meeting.unique);
            meetingManifest = {
                date: Ymd,
                meetingSlug,
                meetingType: type,
                meetingUrl: `${BASE_URL}/goto?open&id=${meeting.unique}`,
                categories,
            };
            debug('writing meeting json', meetingManifestPath);
            await writeJson(meetingManifestPath, meetingManifest, t.exact(MeetingManifest));
        }

        for (const category of meetingManifest.categories) {
            for (const agendaItem of category.items) {
                const { itemId, itemOrder, itemName, itemSlug } = agendaItem;
                if (itemId === null) {
                    continue;
                }
                if (args.query !== undefined && !itemName.toLowerCase().includes(args.query.toLowerCase())) {
                    debug('skipping agenda item that does not match query', itemName);
                    continue;
                }

                let item: IItemManifest | undefined;
                const itemJsonPath = path.join(meetingSlug, itemSlug, 'item.json');
                if (await fileExists(itemJsonPath)) {
                    item = await parseFile(itemJsonPath, ItemManifest);
                    debug('read item json', itemJsonPath);
                }
                if (item === undefined || item.innerHtml === undefined) {
                    debug('fetching item', Ymd, category.categoryOrder, itemOrder, itemName);
                    try {
                        const { innerHtml, links } = await getItemDetail(itemId);
                        item = {
                            ...agendaItem,
                            itemUrl: `${BASE_URL}/goto?open&id=${itemId}`,
                            links,
                            innerHtml,
                        };
                        debug('writing item json', itemJsonPath);
                        await writeJson(itemJsonPath, item, t.exact(ItemManifest));
                    } catch (err) {
                        console.error('failed to fetch item', itemId, itemName, err);
                        continue;
                    }
                }

                if (item.links.length > 0 && args.download) {
                    for (const link of item.links) {
                        const p = path.join(meetingSlug, itemSlug, link.filename);
                        if (await fileExists(p)) {
                            debug('File already exists; skipping', p);
                        } else {
                            debug('writing attachment', p, 'from', link.href);
                            await fsPromises.mkdir(path.dirname(p), { recursive: true });
                            await sleep(REQUEST_DELAY_MS);
                            try {
                                const resp = await fetchWithRetry(link.href, {
                                    headers: { 'User-Agent': USER_AGENT },
                                });
                                if (!resp.ok) {
                                    throw new Error(`HTTP ${resp.status}`);
                                }
                                await fsPromises.writeFile(
                                    p,
                                    Readable.fromWeb(resp.body! as ReadableStream<Uint8Array>)
                                );
                            } catch (err) {
                                // BoardDocs occasionally has broken/stale attachment links (upstream data
                                // issue, e.g. double-encoded filenames that 400/404 either way); don't let
                                // one bad file abort the whole scrape.
                                console.error('failed to download', link.href, err);
                            }
                        }
                    }
                }
            }
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
