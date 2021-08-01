const { expect, matchTemplate, MatchStyle } = require('@aws-cdk/assert');
const cdk = require('@aws-cdk/core');
const lss = require('../lib/lambda-stack');

test('Empty Stack', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new lss.LambdaApiStack(app, 'MyTestStack');
  // THEN
  
  //expect(stack).to(matchTemplate({
  //  "Resources": {}
  //}, MatchStyle.EXACT))
});
