const cdk = require('@aws-cdk/core');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const apigw = require('@aws-cdk/aws-apigateway');
const sqs = require('@aws-cdk/aws-sqs');
const sns = require('@aws-cdk/aws-sns');
const subs = require('@aws-cdk/aws-sns-subscriptions');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
const { SqsEventSource } = require('@aws-cdk/aws-lambda-event-sources');
const { RestApi, MethodLoggingLevel } = require('@aws-cdk/aws-apigateway');
const { PolicyStatement } = require('@aws-cdk/aws-iam');

class LambdaApiStack extends cdk.Stack {
  /**
   * Constructor
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // The environment or stage should be provided as a property. If you do not set the stage, then a
    // default stage of 'dev' will be created.
    this.stageParameter = new cdk.CfnParameter(this, 'stage', {
      type: 'String',
      description: 'The target environment stage (e.g., dev, test, production)',
      default: 'alpha',
      allowedValues: ['alpha', 'beta', 'gamma', 'prod']
    });

    console.log('stage => ' + this.stageParameter.valueAsString);

    this.createDynamoTables();
    this.createQueues();
    this.createLambdaExecutionRole();
    this.createLambdaFunctions();
    this.createLambdaDeploymentRole();
    this.createApi();
  }

  queueArns() {
    return [ this.queueValidation.queueArn ];
  }

  createQueues() {
    this.queueValidation = new sqs.Queue(this, "QueueValidation", {
      queueName: this.stageParameter.valueAsString + '_ValidationQueue',
      encryption: sqs.QueueEncryption.UNENCRYPTED
    });

    this.topicValidation = new sns.Topic(this, 'TopicValidation', {
      topicName: this.stageParameter.valueAsString + '_ValidationTopic'
    });

    this.topicValidation.addSubscription(new subs.SqsSubscription(this.queueValidation));

    new cdk.CfnOutput(this, 'validationQueueArn', {
      value: this.queueValidation.queueArn,
      description: 'The arn for the validation queue'
    });

    new cdk.CfnOutput(this, 'validationTopicArn', {
      value: this.topicValidation.topicArn,
      description: 'The arn for the validation topic'
    });
  }

  dynamoTableArns() {
    return [
      this.tblDevices.tableArn,
      this.tblInfractions.tableArn
    ];
  }

  createDynamoTables() {
    this.tblDevices = new dynamodb.Table(this, 'DynamoDBDevices', {
      tableName: this.stageParameter.valueAsString + '_devices',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING
      },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    this.tblInfractions = new dynamodb.Table(this, 'DynamoDBInfractions', {
      tableName: this.stageParameter.valueAsString + '_infractions',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING
      },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    this.tblInfractions.addGlobalSecondaryIndex({
      indexName: 'reporter-timestamp-index',
      partitionKey: { name: 'reporter', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    new cdk.CfnOutput(this, 'infractionsTable', {
      value: this.tblInfractions.tableArn,
      description: 'The arn for the infractions table'
    });

    new cdk.CfnOutput(this, 'devicesTable', {
      value: this.tblDevices.tableArn,
      description: 'The arn for the devices table'
    });
  }

  /**
   * Creates a RestApi gateway.
   */

  createApi() {
    let api = new RestApi(this, 'RestApi', {
      restApiName: this.stageParameter.valueAsString + '_api',
      deployOptions: {
        stageName: "prod",
        metricsEnabled: true,
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      }
    });

    let hello = api.root.addResource('hello');
    hello.addMethod('GET', new apigw.LambdaIntegration(this.lambdaHelloWorld, { proxy: true }));

    let infraction = api.root.addResource('infraction');
    infraction.addMethod('POST', new apigw.LambdaIntegration(this.lambdaInfractions, { proxy: true }));

    let infractionById = infraction.addResource('{id}');
    infractionById.addMethod('GET', new apigw.LambdaIntegration(this.lambdaInfractions, { proxy: true }));

    let infractionTypes = api.root.addResource('infraction-types');
    infractionTypes.addMethod('GET', new apigw.LambdaIntegration(this.lambdaInfractionTypes, { proxy: false }));

    let devices = api.root.addResource('device');
    devices.addMethod('POST', new apigw.LambdaIntegration(this.lambdaDevices, { proxy: true }));

    let deviceById = devices.addResource('{id}');
    deviceById.addMethod('GET', new apigw.LambdaIntegration(this.lambdaDevices, { proxy: true }));

    let reports = api.root.addResource('reports');
    let reportsWallOfShame = reports.addResource('wallofshame');
    reportsWallOfShame.addMethod('GET', new apigw.LambdaIntegration(this.lambdaReportsWallOfShame, { proxy: true }));

    new cdk.CfnOutput(this, 'restApi', {
      value: api.url,
      description: 'The API endpoint'
    });

    this.api = api;
  }

  lambdaArns() {
    return this.lambdaFunctions.map(v => v.functionArn);
  }


  /**
   * Create placeholders for the lambda functions.  These will start as 'blank'.
   * @todo - connect these to a deployment pipeline.
   */

  createLambdaFunctions() {
    this.initialCode = lambda.Code.fromAsset("./src");

    this.lambdaHelloWorld = new lambda.Function(this, 'LambdaFunction_HelloWorld', {
      functionName: this.stageParameter.valueAsString + '_helloworld',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });
    
    this.lambdaInfractions = new lambda.Function(this, 'LambdaFunction_Infractions', {
      functionName: this.stageParameter.valueAsString + '_infractions',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole,
      environment: {
        REGION: cdk.Stack.of(this).region,
        DBTBL_INFRACTIONS: this.tblInfractions.tableName,
        QUEUE_VALIDATION: this.queueValidation.queueName
      }
    });

    this.lambdaInfractionTypes = new lambda.Function(this, 'LambdaFunction_InfractionTypes', {
      functionName: this.stageParameter.valueAsString + '_infraction_types',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });

    this.lambdaDevices = new lambda.Function(this, 'LambdaFunction_Devices', {
      functionName: this.stageParameter.valueAsString + '_devices',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole,
      environment: {
        REGION: cdk.Stack.of(this).region,
        DBTBL_DEVICES: this.tblDevices.tableName
      }
    });

    this.lambdaReportsWallOfShame = new lambda.Function(this, 'LambdaFunction_WallOfShame', {
      functionName: this.stageParameter.valueAsString + '_reports_wos',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });

    this.lambdaInfractionValidator = new lambda.Function(this, 'LambdaFunction_InfractionValidator', {
      functionName: this.stageParameter.valueAsString + '_infraction_validator',
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });

    this.lambdaInfractionValidator.addEventSource(
        new SqsEventSource(this.queueValidation, {
          batchSize: 10
        }));

    this.apiLambdaFunctions = [
      this.lambdaHelloWorld,
      this.lambdaInfractions,
      this.lambdaInfractionTypes,
      this.lambdaDevices,
      this.lambdaReportsWallOfShame
    ];

    this.apiLambdaFunctions.forEach(myFunction => myFunction.grantInvoke(new iam.ServicePrincipal('apigateway.amazonaws.com')));

    this.sqsLambdaFunctions = [
        this.lambdaInfractionValidator
    ];

    this.lambdaFunctions = this.apiLambdaFunctions.concat(this.sqsLambdaFunctions);
  }

  /**
   * Creates the IAM role that will be used by the lambda functions.  The lambda functions
   * require access to the following resources:
   *    - dynamodb
   */
  createLambdaExecutionRole() {  
    let dynamoReadWritePolicyStatement = new PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: this.dynamoTableArns()
    });

    let dynamoReadWritePolicy = new iam.ManagedPolicy(this, 'LambdaDynamoExecutionPolicy', {
      statements: [ dynamoReadWritePolicyStatement ]
    });

    let sqsReadWritePolicyStatement = new PolicyStatement({
      actions: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:DeleteMessage"],
      resources: this.queueArns()
    });

    let sqsReadWritePolicy = new iam.ManagedPolicy(this, 'LambdaSQSPolicy', {
      statements: [ sqsReadWritePolicyStatement ]
    });

    let snsReadWritePolicyStatement = new PolicyStatement({
      actions: ["sns:Publish"],
      resources: [this.topicValidation.topicArn]
    });

    let snsReadWritePolicy = new iam.ManagedPolicy(this, 'LambdaSNSPolicy', {
      statements: [ snsReadWritePolicyStatement ]
    });

    let lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for lambda',
      managedPolicies: [ dynamoReadWritePolicy, snsReadWritePolicy, sqsReadWritePolicy ]
    });

    this.lambdaExecutionRole = lambdaExecutionRole;
  }

  createLambdaDeploymentRole() {
    let lambdaDeploymentPolicyStatement = new PolicyStatement({
      actions: ["lambda:*"],
      resources: this.lambdaArns()
    });

    let lambdaPolicy = new iam.ManagedPolicy(this, 'LambdaDeploymentPolicy', {
      statements: [ lambdaDeploymentPolicyStatement ]
    });

    let lambdaDeploymentRole = new iam.Role(this, 'LambdaDeploymentRole', {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      description: 'Role for lambda CodeDeployment',
      managedPolicies: [ lambdaPolicy ]
    });

    this.lambdaDeploymentRole = lambdaDeploymentRole;
  }
}

module.exports = { LambdaApiStack }
