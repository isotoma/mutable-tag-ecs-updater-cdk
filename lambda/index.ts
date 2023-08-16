import * as ecs from '@aws-sdk/client-ecs';
import * as secretsmanager from '@aws-sdk/client-secrets-manager';

import * as utils from './utils';

class SecretsManagerMemoryCache {
    protected _ttlSeconds: number | undefined;
    protected _secretName: string | undefined;
    protected _value: string | undefined;
    protected lastAccessed: Date | undefined;

    constructor() {
        this._ttlSeconds = undefined;
        this._secretName = undefined;
        this._value = undefined;
        this.lastAccessed = undefined;
    }

    setTtlSeconds(ttlSeconds: number): void {
        this._ttlSeconds = ttlSeconds;
    }

    setSecretName(secretName: string): void {
        if (typeof this._secretName === 'undefined') {
            this._secretName = secretName;
            return;
        }

        if (this._secretName === secretName) {
            return;
        }
        throw new Error(`Cannot set secret name to a new value once set. Was ${this._secretName}, trying to set to ${secretName}`);
    }

    async getValue(): Promise<string> {
        const secretName = this._secretName;
        const ttlSeconds = this._ttlSeconds;

        if (!secretName) {
            throw new Error('Cannot get value before calling setSecretName');
        }

        if (!ttlSeconds) {
            throw new Error('Cannot get value before calling setTtlSeconds');
        }

        if (
            typeof this._value === 'undefined' ||
            typeof this.lastAccessed === 'undefined' ||
            new Date().getTime() - this.lastAccessed.getTime() > ttlSeconds * 1000
        ) {
            const smclient = new secretsmanager.SecretsManager();
            const accessedAt = new Date();
            console.log(`Retrieving secret value from ${secretName}`);
            const value = (
                await smclient.getSecretValue({ SecretId: secretName })
            ).SecretString;

            if (typeof value !== 'string') {
                throw new Error(`Unable to get secretString for ${secretName}`);
            }
            this._value = value;
            this.lastAccessed = accessedAt;
            return value;
        }
        console.log(`Using cached value for ${secretName}`);
        return this._value;
    }
}

const ghcrPullSecretCache = new SecretsManagerMemoryCache();

interface HandlerResponse {
    success: boolean;
    result: string;
}

export const handler = async (): Promise<HandlerResponse> => {
    const ecsClusterName = process.env['ECS_CLUSTER_NAME'];
    if (!ecsClusterName) {
        throw new Error('Expected env var ECS_CLUSTER_NAME, but not set');
    }
    const ecsServiceName = process.env['ECS_SERVICE_NAME'];
    if (!ecsServiceName) {
        throw new Error('Expected env var ECS_SERVICE_NAME, but not set');
    }
    const ghcrPullSecretName = process.env['GHCR_PULL_SECRET_NAME'];
    if (!ghcrPullSecretName) {
        throw new Error('Expected env var GHCR_PULL_SECRET_NAME, but not set');
    }
    const ghcrPullSecretCacheSecondsTtlString = process.env['GHCR_PULL_SECRET_CACHE_SECONDS_TTL'];
    if (!ghcrPullSecretCacheSecondsTtlString) {
        throw new Error('Expected env var GHCR_PULL_SECRET_CACHE_SECONDS_TTL, but not set');
    }
    const ghcrPullSecretCacheSecondsTtl = parseInt(ghcrPullSecretCacheSecondsTtlString, 10);
    const alwaysUpdate = !!process.env['ALWAYS_UPDATE'];

    ghcrPullSecretCache.setTtlSeconds(ghcrPullSecretCacheSecondsTtl);
    ghcrPullSecretCache.setSecretName(ghcrPullSecretName);

    const githubTokenRaw = await ghcrPullSecretCache.getValue();
    const githubTokenParsed: unknown = JSON.parse(githubTokenRaw);

    if (!utils.hasKey('password', githubTokenParsed)) {
        console.error(`JSON from secret ${ghcrPullSecretName} missing required key 'password'`);
        return {
            success: false,
            result: 'Falied to get password from secret',
        };
    }

    const githubToken = githubTokenParsed.password;
    if (typeof githubToken !== 'string') {
        console.error(`Value of password from secret ${ghcrPullSecretName} is not a string`);
        return {
            success: false,
            result: 'Values for password from secret not a string',
        };
    }

    const ecsclient = new ecs.ECS();

    const servicesResponse = await ecsclient.describeServices({
        cluster: ecsClusterName,
        services: [ecsServiceName],
    })

    const service = (servicesResponse.services ?? [])[0];

    if (!service) {
        console.error(`Unable to describe service ${ecsServiceName} in cluster ${ecsClusterName}`);

        return {
            success: false,
            result: 'Service not found',
        };
    }

    for (const deployment of service.deployments ?? []) {
        if (deployment.rolloutState === 'IN_PROGRESS') {
            console.error(`Found a deployment with rolloutState of IN_PROGRESS. Nothing to do.`);
            return {
                success: true,
                result: 'Rollout already in progress. Nothing to do.',
            };
        }
    }

    const taskArns = (
        await ecsclient.listTasks({
            cluster: ecsClusterName,
            desiredStatus: 'RUNNING',
            serviceName: ecsServiceName,
        })
    ).taskArns;

    if (!taskArns) {
        throw new Error('No task ARNs found');
    }

    const tasksResponse = await ecsclient.describeTasks({
        cluster: ecsClusterName,
        tasks: taskArns,
    })

    const imagesInUse = new Set<string>();

    let oldestTaskCreatedAt: Date | undefined = undefined;

    for (const task of tasksResponse.tasks ?? []) {
        for (const container of task.containers ?? []) {
            if (container.image) {
                imagesInUse.add(container.image);
            }
        }

        oldestTaskCreatedAt = utils.oldestDate(oldestTaskCreatedAt, task.createdAt);
    }

    let newestImageCreatedAt: Date | undefined = undefined;

    for (const image of imagesInUse) {
        const parsedImage = utils.parseImage(image);
        if (!parsedImage) {
            console.error(`Skipping unparsable image: ${image}`);
            continue;
        } else {
            console.log(`Handling image: ${image}`);
        }
        // @ts-expect-error fetch is not recognised as a valid global.
        const response = await fetch(`https://api.github.com/orgs/${parsedImage.org}/packages/container/${parsedImage.repository}/versions`, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${githubToken}`,
            },
        });

        const responseJson: unknown = await response.json();

        if (!Array.isArray(responseJson)) {
            console.error('Response JSON from Github is not an array');
            continue;
        }

        for (const item of responseJson) {
            if (!utils.hasKey('metadata', item)) {
                console.error('Skipping image record from Github, has no metadata');
                continue;
            }
            const metadata = item.metadata;
            if (!utils.hasKey('container', metadata)) {
                console.error('Skipping image record from Github, has no metadata.container');
                continue;
            }
            const metadataContainer = metadata.container;
            if (!utils.hasKey('tags', metadataContainer)) {
                console.error('Skipping image record from Github, has no metadata.container.tags');
                continue;
            }
            const metadataContainerTags = metadataContainer.tags;
            if (!utils.isArrayOfStrings(metadataContainerTags)) {
                console.error('Skipping image record from Github, metadata.container.tags is not an array of strings');
                continue;
            }

            if (!utils.hasKey('created_at', item)) {
                console.error('Skipping image record from Github, has no created_at');
                continue;
            }

            const createdAt = item.created_at;

            if (typeof createdAt !== 'string') {
                console.error('Skipping image record from Github, created_at is not a string');
                continue;
            }

            if (metadataContainerTags.includes(parsedImage.tag)) {
                newestImageCreatedAt = utils.newestDate(newestImageCreatedAt, new Date(createdAt));
                break;
            }
        }
    }

    console.log('Oldest task created at:', oldestTaskCreatedAt);
    console.log('Newest image created at:', newestImageCreatedAt);

    if (!oldestTaskCreatedAt) {
        console.error('Unable to determine oldest task created at. Unable to proceed');
        return {
            success: false,
            result: 'Unable to determine oldest task created at. Unable to proceed',
        };
    }

    if (!newestImageCreatedAt) {
        console.error('Unable to determine newest image created at. Unable to proceed');
        return {
            success: false,
            result: 'Unable to determine newest image created at. Unable to proceed',
        };
    }

    if (oldestTaskCreatedAt.getTime() > newestImageCreatedAt.getTime()) {
        console.log('Oldest task newer than newest image, nothing to do');
        if (!alwaysUpdate) {
            return {
                success: true,
                result: 'Oldest task newer than newest image, nothing to do',
            };
        }
        console.log('But ALWAYS_UPDATE was set, so updating anyway');
    } else {
        console.log('Oldest task is older than newest image, need to update');
    }

    await ecsclient.updateService({
        cluster: ecsClusterName,
        service: ecsServiceName,
        forceNewDeployment: true,
    })

    console.log(`Updated service ${ecsServiceName} in cluster ${ecsClusterName}`);
    return {
        success: true,
        result: 'Updated service',
    };
};
