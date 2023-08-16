import * as pathlib from 'path';
import { Stack, Tags, Duration, Arn } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdanodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface MutableTagEcsUpdaterProps {
    ecsCluster: ecs.Cluster;
    ecsService: ecs.BaseService;
    pullSecret: secretsmanager.Secret;
    autoUpdateRate?: string;
    clusterStack?: Stack;
}

export class MutableTagEcsUpdater extends Construct {
    constructor(scope: Construct, id: string, props: MutableTagEcsUpdaterProps) {
        super(scope, id);

        const tagUpdateLambda = new lambdanodejs.NodejsFunction(this, 'AutoUpdateLambda', {
            entry: pathlib.join(__dirname, './lambda/index.js'),
            environment: {
                ECS_CLUSTER_NAME: props.ecsCluster.clusterName,
                ECS_SERVICE_NAME: props.ecsService.serviceName,
                GHCR_PULL_SECRET: props.pullSecret.secretName,
                GHCR_PULL_SECRET_CACHE_SECONDS_TTL: String(Duration.days(1).toSeconds()),
            },
            memorySize: 512,
            handler: 'handler',
        });

        const autoUpdateRule = new events.Rule(this, 'AutoUpdateRule', {
            schedule: events.Schedule.rate(Duration.parse(props.autoUpdateRate ?? 'PT5M')),
            targets: [new eventsTargets.LambdaFunction(tagUpdateLambda)],
        });

        props.pullSecret.grantRead(tagUpdateLambda);

        tagUpdateLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
                resources: [props.ecsService.serviceArn],
            }),
        );
        tagUpdateLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ecs:ListTasks'],
                resources: ['*'],
            }),
        );
        tagUpdateLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ecs:DescribeTasks'],
                resources: [
                    `${props.ecsService.serviceArn}/*`,
                    Arn.format(
                        {
                            resource: 'task',
                            service: 'ecs',
                            resourceName: `${props.ecsCluster.clusterName}/*`,
                        },
                        props.clusterStack,
                    ),
                ],
            }),
        );

        for (const resource of [tagUpdateLambda, autoUpdateRule]) {
            Tags.of(resource).add('Component', 'AutoUpdate');
        }
    }
}
