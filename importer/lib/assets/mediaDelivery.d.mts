export interface MediaDelivery { version: 1; baseRevision: string; overrides: Record<string, string> }
export type MediaDeliveryMaps = Record<string, Record<string, MediaDelivery>>;
export declare const MAX_MEDIA_DELIVERY_BYTES: number;
export function mediaGroup(repository: string, path: string): string;
export function validateMediaDelivery(value: unknown): MediaDeliveryMaps;
export function mediaRevision(maps: MediaDeliveryMaps | undefined, repository: string, revision: string, encodedPath: string, rawPath?: boolean): string;
