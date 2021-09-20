import * as t from 'io-ts';

export const MeetingItem = t.type(
    {
        itemId: t.union([t.string, t.null]),
        itemOrder: t.string,
        itemName: t.string,
        itemSlug: t.string,
    },
    'MeetingItem'
);
export type IMeetingItem = t.TypeOf<typeof MeetingItem>;

export const MeetingCategory = t.type(
    {
        categoryId: t.union([t.string, t.null, t.undefined]),
        categoryOrder: t.union([t.string, t.undefined]),
        categoryName: t.union([t.string, t.undefined]),
        items: t.array(MeetingItem),
    },
    'MeetingCategory'
);
export type IMeetingCategory = t.TypeOf<typeof MeetingCategory>;

export const MeetingManifest = t.type(
    {
        date: t.string,
        meetingSlug: t.string,
        meetingType: t.string,
        meetingUrl: t.union([t.string, t.null]),
        categories: t.array(MeetingCategory),
    },
    'MeetingManifest'
);
export type IMeetingManifest = t.TypeOf<typeof MeetingManifest>;
