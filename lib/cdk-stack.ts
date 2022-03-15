import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { CfnGlobalReplicationGroup, CfnReplicationGroup, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AuroraPostgresEngineVersion, DatabaseClusterEngine, ParameterGroup } from 'aws-cdk-lib/aws-rds';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { GlobalAuroraRDSMaster, GlobalAuroraRDSSlaveInfra } from 'cdk-aurora-globaldatabase';
import { Construct } from 'constructs';
import { Config } from './config';
import { SSMParameterReader } from './reader';
import { ReplicatedBucket } from './replicated';
export class AppStack extends Stack {
  public bucket: Bucket;
  
  private static redisGlobalPrefix:{[key:string]:string}={
    "us-east-2":"fpkhr",
    "us-east-1":"ldgnf",
    "us-west-1":"virxk",
    "us-west-2":"sgaui",
    "ca-central-1":"bxodz",
    "ap-south-1":"erpgt",
    "ap-northeast-1":"quwsw",
    "ap-northeast-2":"lfqnh",
    "ap-northeast-3":"nlapn",
    "ap-southeast-1":"vlqxn",
    "ap-southeast-2":"vbgxd",
    "eu-central-1":"iudkw",
    "eu-west-1":"gxeiz",
    "eu-west-2":"okuqm",
    "eu-west-3":"fgjhi",
    "sa-east-1":"juxlw",
    "cn-north-1":"emvgo",
    "cn-northwest-1":"ckbem",
    "ap-east-1":"knjmp",
    "us-gov-west-1":"sgwui",
  };

  constructor(scope: Construct, id: string, props: StackProps, config: Config) {
    super(scope, id, props);

    // default AZs = 3, public+private subnet per AZ
    const vpc = new Vpc(this, 'vpc', {
      cidr: config.cidr,
      vpcName: `${config.primary ? "primary" : "secondary"}VPC`
    });

    const replicaRole = new Role(this, 'replicationRole', {
      assumedBy: new ServicePrincipal('s3.amazonaws.com')
    });

    var bucket;
    
    if (config.primary) {
      bucket = new ReplicatedBucket(this, 'staticFiles', {
        bucketName: `static-files-${Stack.of(this).account}-${config.primaryRegion}`,
        removalPolicy: RemovalPolicy.DESTROY,
        versioned: true,
        replicationConfiguration: {
          role: replicaRole.roleArn,
          rules: [{
            status: 'Disabled',
            destination: {
              bucket: `arn:aws:s3:::static-files-${Stack.of(this).account}-${config.secondaryRegion}`
            }
          }]
        }
      });
    } else {
      bucket = new Bucket(this, 'staticFiles', {
        versioned: true,
        removalPolicy: RemovalPolicy.DESTROY,
        bucketName: `static-files-${Stack.of(this).account}-${config.primaryRegion}`
      });
    }

    const result = this.setupPreRedis(vpc);
    
    new StringParameter(this, `redisSecGroupId-${Stack.of(this).region}`, {
      parameterName: `redisSecGroupId-${Stack.of(this).region}`,
      stringValue: result.securityGroup.securityGroupId,
    });

    if (config.primary) {
      AppStack.setupRedis(this,result.securityGroup.securityGroupId, true, config.primaryRegion, config.secondaryRegion, result.subnetGroup);
    }

    this.setupAurora(vpc, config.primary, config.secondaryRegion);

    this.bucket = bucket;
  }

  protected setupPreRedis(vpc: IVpc) {
    const secGroup = new SecurityGroup(this, 'redisSecGroup', { vpc: vpc });
    secGroup.connections.allowFrom(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(6379));

    const subnetGroup = new CfnSubnetGroup(this, 'redisSubnetGroup', {
      cacheSubnetGroupName: `redisSubnetGroup-${Stack.of(this).account}`,
      subnetIds: vpc.selectSubnets({ subnetGroupName: 'Private' }).subnetIds,
      description: 'SubnetGroup for Redis Cluster'
    });

    return {"securityGroup": secGroup, "subnetGroup":subnetGroup };
  }

  public static setupRedis(scope:Construct, secGroupId: string, isPrimary: boolean, primaryRegion: string, secondaryRegion?: string, subnetGroup?: CfnSubnetGroup) {
    const redisReplGroup = new CfnReplicationGroup(scope, 'redis', {
      replicationGroupId: `redis-${Stack.of(scope).account}-${Stack.of(scope).region}`,
      replicationGroupDescription: 'Redis Replication Group',
      cacheNodeType: isPrimary ? 'cache.m5.large' : undefined,
      cacheSubnetGroupName: isPrimary ? subnetGroup?.cacheSubnetGroupName :`redisSubnetGroup-${Stack.of(scope).account}`,
      multiAzEnabled: isPrimary ? true : undefined,
      numCacheClusters: 2,
      automaticFailoverEnabled: isPrimary ? true : undefined,
      engine: isPrimary ? 'redis' : undefined,
      port: 6379,
      securityGroupIds: [secGroupId],
      snapshotRetentionLimit: 7,
      globalReplicationGroupId: isPrimary ? undefined : `${this.redisGlobalPrefix[primaryRegion]}-globalredis`
    });
    
    if (isPrimary) {
      if (subnetGroup) {
        redisReplGroup.addDependsOn(subnetGroup);
      } 
      const globalReplicationGroup = new CfnGlobalReplicationGroup(scope, 'globalRedis', {
        globalReplicationGroupIdSuffix: 'globalredis',
        members: [
          { replicationGroupId: redisReplGroup.replicationGroupId, replicationGroupRegion: Stack.of(scope).region, role: 'PRIMARY' }
        ],
        regionalConfigurations: [{ replicationGroupId: 'secondary', replicationGroupRegion: secondaryRegion }]
      });
      globalReplicationGroup.addDependsOn(redisReplGroup);
    }
  }

  private setupAurora(vpc: Vpc, isPrimary: boolean, secondaryRegion: string) {
    if (isPrimary) {
      const dbSubnetName = new SSMParameterReader(this,'dbSubnetName',{
        parameterName: `aurora-secondary-subnet-${secondaryRegion}`, 
        region: secondaryRegion
      }).getParameterValue();

      const v17 = DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_11_7
      });

      const primary = new GlobalAuroraRDSMaster(this, 'primaryAurora', {
        vpc: vpc,
        engineVersion: v17,
        rdsPassword: '1qidhqwwu3',
        dbClusterpPG: new ParameterGroup(this, 'dbClusterparametergroup', {
          engine: v17,
          parameters: {
            'rds.force_ssl': '1',
            'rds.log_retention_period': '10080',
            'auto_explain.log_min_duration': '5000',
            'auto_explain.log_verbose': '1',
            'timezone': 'UTC+8',
            'shared_preload_libraries': 'auto_explain,pg_stat_statements,pg_hint_plan,pgaudit',
            'log_connections': '1',
            'log_statement': 'ddl',
            'log_disconnections': '1',
            'log_lock_waits': '1',
            'log_min_duration_statement': '5000',
            'log_rotation_age': '1440',
            'log_rotation_size': '102400',
            'random_page_cost': '1',
            'track_activity_query_size': '16384',
            'idle_in_transaction_session_timeout': '7200000',
          },
        }),
        
      });

      primary.addRegionalCluster(this,'auroraRegional',{
        region: secondaryRegion,
        dbSubnetGroupName: dbSubnetName
      });
    } else {
      const secondary = new GlobalAuroraRDSSlaveInfra(this, 'secondaryAurora', { vpc: vpc });
      new StringParameter(this, `aurora-secondary-subnet-${Stack.of(this).region}`, {
        parameterName: `aurora-secondary-subnet-${Stack.of(this).region}`,
        stringValue: secondary.dbSubnetGroup.dbSubnetGroupName || "",
      });
    }
  }
}

export class RedisSecondaryStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps, primaryRegion: string) {
    super(scope, id, props);

    const redisSecGroupId = new SSMParameterReader(this,'redisSecGroupId',{parameterName: `redisSecGroupId-${props.env?.region}`, region: props.env?.region || ""}).getParameterValue();
    AppStack.setupRedis(this,redisSecGroupId, false, primaryRegion);
  }
}