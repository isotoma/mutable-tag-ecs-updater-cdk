import * as pathlib from 'path';
import { Stack, Tags, Duration, Arn } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface MutableTagEcsUpdaterProps {
    ecsCluster: ecs.ICluster;
    ecsService: ecs.IBaseService;
    pullSecret: secretsmanager.ISecret;
    autoUpdateRate?: string;
    clusterStack?: Stack;
}

export class MutableTagEcsUpdater extends Construct {
    constructor(scope: Construct, id: string, props: MutableTagEcsUpdaterProps) {
        super(scope, id);

        const tagUpdateLambda = new lambda.Function(this, 'AutoUpdateLambda', {
            code: lambda.Code.fromAsset(pathlib.join(__dirname, 'lambda')),
            runtime: lambda.Runtime.NODEJS_16_X,
            handler: 'index.handler',
            environment: {
                ECS_CLUSTER_NAME: props.ecsCluster.clusterName,
                ECS_SERVICE_NAME: props.ecsService.serviceName,
                GHCR_PULL_SECRET: props.pullSecret.secretName,
                GHCR_PULL_SECRET_CACHE_SECONDS_TTL: String(Duration.days(1).toSeconds()),
            },
            memorySize: 512,
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
