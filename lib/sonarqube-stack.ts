import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as route53 from "@aws-cdk/aws-route53";
import * as elasticloadbalancing from "@aws-cdk/aws-elasticloadbalancingv2";
import * as route53targets from "@aws-cdk/aws-route53-targets";
import { CfnOutput, RemovalPolicy } from "@aws-cdk/core";
import * as ecr from "@aws-cdk/aws-ecr";
import * as certificatemanager from "@aws-cdk/aws-certificatemanager";
import * as rds from "@aws-cdk/aws-rds";

export const SSM_PREFIX = "/sonarqube-fargate-cdk";
export const CLUSTER_NAME = "sonarqube-fargate";

export class SonarqubeStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const applicationPort = 9000;

    const vpc = ec2.Vpc.fromLookup(this, `VPC`, {
      vpcId: "vpc-REPLACEME",
    });

    const zone = route53.HostedZone.fromLookup(this, `HostedZone`, {
      domainName: "yourdomain.com",
    });

    const defaultDomainName = "yourdomain.com";

    const certificate = new certificatemanager.Certificate(
      this,
      "DefaultDomainCertificate",
      {
        domainName: defaultDomainName,
        validation: certificatemanager.CertificateValidation.fromDns(zone),
      }
    );
    const defaultDatabaseName = "sonarqube";
    const database = new rds.DatabaseInstance(this, "Instance", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_10_20,
      }),
      // optional, defaults to m5.large
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE2,
        ec2.InstanceSize.MEDIUM
      ),
      vpc,
      databaseName: defaultDatabaseName,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"), // Creates an admin user of postgres with a generated password
    });
    database.connections.allowFrom(
      ec2.Peer.ipv4("YOUR_CIDR"),
      ec2.Port.tcp(5432),
      "Only container can reach the database"
    );

    const securityGroupName = `ecssg-sonarqube`;
    const ecsSecurityGroup = new ec2.SecurityGroup(this, "ecs-security-group", {
      vpc,
      securityGroupName,
      description: `ECS Fargate shared security group for ALB ingress, cluster}`,
    });
    const albSecurityGroupName = `albsg-sonarqube`;

    const albSecurityGroup = new ec2.SecurityGroup(this, albSecurityGroupName, {
      securityGroupName: albSecurityGroupName,
      vpc,
      allowAllOutbound: true,
      description: `ALB security group for SonarQube Service`,
    });
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(applicationPort),
      "Allow from ALB"
    );
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(9092),
      "Allow from ElasticSearch"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow any"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9092),
      "Allow any"
    );

    const alb = new elasticloadbalancing.ApplicationLoadBalancer(
      this,
      `ApplicationLoadBalancer`,
      {
        loadBalancerName: `sonarqube-lb`,
        vpc,
        vpcSubnets: { subnets: vpc.publicSubnets },
        internetFacing: true,
        securityGroup: ecsSecurityGroup,
      }
    );

    const listener = alb.addListener(`Listener`, {
      open: true,
      port: 443,
      certificates: [certificate],
    });

    const targetGroupHttp = new elasticloadbalancing.ApplicationTargetGroup(
      this,
      `TargetGroup`,
      {
        port: 443,
        vpc,
        protocol: elasticloadbalancing.ApplicationProtocol.HTTP,
        targetType: elasticloadbalancing.TargetType.IP,
      }
    );

    targetGroupHttp.configureHealthCheck({
      path: `/healthcheck/`,
      protocol: elasticloadbalancing.Protocol.HTTP,
      healthyHttpCodes: "200,204",
      port: applicationPort.toString(),
    });

    listener.addTargetGroups(`TargetGroups`, {
      targetGroups: [targetGroupHttp],
    });

    new cdk.CfnOutput(this, "AlbListenerArnOutput", {
      value: listener.listenerArn,
      exportName: `sonarqube-alb-listener-arn`,
    });

    const securityGroups = cdk.Fn.join(",", alb.loadBalancerSecurityGroups);

    new cdk.CfnOutput(this, "AlbSecurityGroupsOutput", {
      value: securityGroups,
      exportName: `sonarqube-alb-security-groups`,
    });

    const clusterName = `sonarqube-ecs-cluster`;
    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc,
      clusterName,
      containerInsights: true,
    });

    new route53.ARecord(this, `DefaultDomainARecord`, {
      recordName: defaultDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(alb)
      ),
      ttl: cdk.Duration.seconds(300),
      comment: `Default Domain`,
      zone: zone,
    });

    new CfnOutput(this, "Cluster", { value: cluster.clusterName });
    new CfnOutput(this, "ECS Security Group ID", {
      value: ecsSecurityGroup.securityGroupId,
    });

    const ecrRepo = new ecr.Repository(this, `ECR`, {
      repositoryName: `sonarqube-ecr`,
      removalPolicy: RemovalPolicy.DESTROY,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          tagPrefixList: ["latest"],
          maxImageCount: 5,
        },
      ],
    });
    const serviceName = "sonarqube-service";

    const taskDefinition = new ecs.TaskDefinition(
      this,
      "fargate-task-definition",
      {
        cpu: "1024",
        memoryMiB: "2048",
        compatibility: ecs.Compatibility.FARGATE,
        family: `${serviceName}-task`,
        networkMode: ecs.NetworkMode.AWS_VPC,
      }
    );

    const image = ecs.RepositoryImage.fromEcrRepository(ecrRepo, "latest");

    const container = taskDefinition.addContainer(`Container`, {
      image,
      memoryReservationMiB: 1024,
      logging: new ecs.AwsLogDriver({
        streamPrefix: `sonarqube`,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
      }),
      command: [
        "-Dsonar.search.javaAdditionalOpts=-Dnode.store.allow_mmap=false",
      ],
      portMappings: [
        {
          containerPort: 9000,
        },
      ],
      environment: {
        "sonar.jdbc.url": `jdbc:postgresql://${database.instanceEndpoint.socketAddress}/${defaultDatabaseName}`,
      },
      secrets: {
        "sonar.jdbc.username": ecs.Secret.fromSecretsManager(
          database.secret!,
          "username"
        ),
        "sonar.jdbc.password": ecs.Secret.fromSecretsManager(
          database.secret!,
          "password"
        ),
      },
    });
    taskDefinition.defaultContainer?.addUlimits({
      name: ecs.UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536,
    });
    container.addPortMappings({ containerPort: applicationPort });

    const service = new ecs.FargateService(this, `AdminService`, {
      serviceName: `sonarqube-service`,
      cluster,
      desiredCount: 1,
      taskDefinition,
    });
    service.attachToApplicationTargetGroup(targetGroupHttp);

    const scalableTaget = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 2,
    });

    scalableTaget.scaleOnMemoryUtilization(`AdminScaleUpMem`, {
      targetUtilizationPercent: 75,
    });

    scalableTaget.scaleOnCpuUtilization(`AdminScaleUpCPU`, {
      targetUtilizationPercent: 75,
    });
  }
}
