import * as t from 'io-ts';

import { MeetingItem } from './MeetingManifest';

export const Link = t.type(
    {
        order: t.union([t.string, t.undefined]),
        unique: t.union([t.string, t.null]),
        href: t.string,
        text: t.string,
        filename: t.string,
    },
    'Link'
);
export type ILink = t.TypeOf<typeof Link>;

export const ItemParsedFromContent = t.type(
    {
        itemUrl: t.union([t.string, t.null]),
        links: t.array(Link),
        innerHtml: t.union([t.string, t.undefined]),
    },
    'ItemParsedFromContent'
);

export const ItemManifest = t.intersection([MeetingItem, ItemParsedFromContent], 'ItemManifest');
export type IItemManifest = t.TypeOf<typeof ItemManifest>;
