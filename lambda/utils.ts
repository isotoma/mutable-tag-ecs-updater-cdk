export const hasKey = <K extends string>(key: K, obj: unknown): obj is { [_ in K]: Record<string, unknown> } => {
    return typeof obj === 'object' && !!obj && key in obj;
};

export const isArrayOfStrings = (arr: unknown): arr is string[] => {
    if (!Array.isArray(arr)) {
        return false;
    }

    for (const item of arr) {
        if (typeof item !== 'string') {
            return false;
        }
    }
    return true;
};

export interface GhcrDockerImage {
    org: string;
    repository: string;
    tag: string;
}

export const selectDate = (d1: Date | undefined, d2: Date | undefined, oldest: boolean): Date | undefined => {
    if (d1) {
        if (d2) {
            if (oldest) {
                if (d1.getTime() < d2.getTime()) {
                    return d1;
                }
                return d2;
            }
            if (d1.getTime() > d2.getTime()) {
                return d1;
            }
            return d2;
        }
        return d1;
    }
    if (d2) {
        return d2;
    }
    return undefined;
};

export const oldestDate = (d1: Date | undefined, d2: Date | undefined): Date | undefined => {
    return selectDate(d1, d2, true);
};

export const newestDate = (d1: Date | undefined, d2: Date | undefined): Date | undefined => {
    return selectDate(d1, d2, false);
};

export const parseImage = (image: string): GhcrDockerImage | undefined => {
    const prefix = 'ghcr.io/';
    if (!image.startsWith(prefix)) {
        return undefined;
    }

    const withoutRegistry = image.substring(prefix.length);

    const tagSplitParts = withoutRegistry.split(':');

    const [orgAndRepository, tag] = tagSplitParts;

    if (!orgAndRepository) {
        return undefined;
    }
    if (!tag) {
        return undefined;
    }

    const orgAndRepositorySplitParts = orgAndRepository.split('/');

    const [org, ...repositoryParts] = orgAndRepositorySplitParts;
    const repository = repositoryParts.join('/');

    if (!repository) {
        return undefined;
    }
    if (!org) {
        return undefined;
    }

    return {
        org,
        repository,
        tag,
    };
};
