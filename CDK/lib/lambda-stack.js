const cdk = require('@aws-cdk/core');
const s3 = require('@aws-cdk/aws-s3');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const apigw = require('@aws-cdk/aws-apigateway');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
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

    this.createDynamoTables();
    this.createLambdaExecutionRole();
    this.createLambdaFunctions();
    this.createApi();
  }

  dynamoTableArns() {
    return [
      this.tblDevices.tableArn,
      this.tblInfractions.tableArn
    ];
  }

  createDynamoTables() {
    this.tblDevices = new dynamodb.Table(this, 'DynamoDBDevices', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING
      },
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    this.tblInfractions = new dynamodb.Table(this, 'DynamoDBInfractions', {
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
  }

  /**
   * Creates a RestApi gateway.
   */

  createApi() {
    let api = new RestApi(this, 'RestApi', {
      deployOptions: {
        stageName: "beta",
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

    const deployment = new apigw.Deployment(this, 'test_deployment', { api });
    const devStage = new apigw.Stage(this, 'dev_stage', { deployment, stageName: 'dev' });
    const prodStage = new apigw.Stage(this, 'prod_stage', { deployment, stageName: 'prod' });

    api.deploymentStage = prodStage

    this.api = api;
  }

  /**
   * Create placeholders for the lambda functions.  These will start as 'blank'.
   * @todo - connect these to a deployment pipeline.
   */

  createLambdaFunctions() {
    this.initialCode = lambda.Code.fromAsset("./src");

    this.lambdaHelloWorld = new lambda.Function(this, 'LambdaFunction_HelloWorld', {
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });
    
    this.lambdaInfractions = new lambda.Function(this, 'LambdaFunction_Infractions', {
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole,
      environment: {
        REGION: cdk.Stack.of(this).region,
        DBTBL_INFRACTIONS: this.tblInfractions.tableName
      }
    });

    this.lambdaInfractionTypes = new lambda.Function(this, 'LambdaFunction_InfractionTypes', {
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });

    this.lambdaDevices = new lambda.Function(this, 'LambdaFunction_Devices', {
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
      handler: "index.handler",
      runtime: lambda.Runtime.NODEJS_14_X,
      code: this.initialCode,
      role: this.lambdaExecutionRole
    });

    this.lambdaFunctions = [
      this.lambdaHelloWorld,
      this.lambdaInfractions,
      this.lambdaInfractionTypes,
      this.lambdaDevices,
      this.lambdaReportsWallOfShame
    ];

    this.lambdaFunctions.forEach(myFunction => myFunction.grantInvoke(new iam.ServicePrincipal('apigateway.amazonaws.com')));
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

    let dynamoReadWritePolicy = new iam.ManagedPolicy(this, 'LambdaExecutionPolicy', {
      statements: [ dynamoReadWritePolicyStatement ]
    });

    let lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for lambda',
      managedPolicies: [ dynamoReadWritePolicy ]
    });

    this.lambdaExecutionRole = lambdaExecutionRole;
  }
}

module.exports = { LambdaApiStack }
