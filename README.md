# autoscaling-route53-lambda
This code can be used to manage Route53 records of type CNAME or A for an Autoscaling Group with Lambda via a tag on the ASG. 
The main function listens for TERMINATE and LAUNCH events, and DELETEs and UPSERTs records to Route53.


## Usage
Create an Autoscaling Group Tag called 'Route53' with values in any of these formats:
*   - Tag Name:  'Route53' (defined in tagName variable)
*   - Tag value:  <four options>
*       1) 'HostedZoneId:record-name'                       Ex. Z1473BHDWSM6GV:www.example.com              (assumes CNAME type and TTL of 1)
*       2) 'HostedZoneId:type:record-name'                  Ex. Z1473BHDWSM6GV:CNAME:www.example.com        (assumes TTL of 1)'
*       3) 'HostedZoneId:type:record-name:ttl'              Ex. Z1473BHDWSM6GV:CNAME:www.example.com:30)'
*       4) <empty string> or value of 'none' is ignored


## ZIP it up
Create ZIP file with `zip ../autoscaling-route53.js index.js async`

## Install (for lack of better words)
AWS makes this relatively easy for you, but you still have to jump some hoops. Let's use the Console for this, as it is easiest. 

For a given Autoscaling Group you want to 'sync' with Route53, do the following:

1. create an IAM role with policies AmazonEC2ReadOnlyAccess, CloudWatchLogsFullAccess and AmazonRoute53FullAccess (our name is AutoscalingRoute53Role)
1. create a Lambda function with ZIP and IAM Role from before (our name is autoscalingRoute53)
1. create an SNS topic (our topic name asg-notifications-staging-elasticsearch-30mhz-com)
1. add a subscription to SNS topic, pointing to the Lambda function
1. on the notifications tab in the details pane of the Autoscaling Group, you click 'Create notification'
1. set 'send notification to' to the SNS topic
1. and only 'launch' and 'terminate' are used by this lambda function. Other messages are ignored.
1. last, but not least, add a tag to the Autoscaling Group with key 'Route53' and value 'HostedZoneId:record-name'

And now, scale :)

## Using Cloudformation
If you want to script this setup with Cloudformation, here is a snippet that covers steps 3 - 7 above.
This snippet would be put into the 'Resources' of a Cloudformation script.

```
"Resources": {

  ....

    "LambdaDNS": {
        "Type": "AWS::Lambda::Function",
        "Properties": {
            "FunctionName" : "asg-to-dns-v1",
            "Code": {
                "S3Bucket": "bionano-devops-build-artifacts",
                "S3Key": "lambdas/lambdaDNS/autoscaling-route53.js.zip"
            },
            "Description" : "Lambda to update dns based on asg events", 
            "Role": { "Fn::Join" : [ "/", [ "arn:aws:iam::123456789012:role", "lambda-asg-sns-dns"] ] },
            "Timeout": 60,
            "Handler": "index.handler",
            "Runtime": "nodejs4.3",
            "MemorySize": 128
        }
    },

    "autoscalingNotificationTopic" : {
      "Type" : "AWS::SNS::Topic",
      "DependsOn" : [ "LambdaDNS" ], 
      "Condition": "IsUSWest2",
      "Properties" : {
        "DisplayName" : "wD Scaling",
        "Subscription" : [ 
            { "Endpoint"  : {"Fn::GetAtt" : [ "LambdaDNS", "Arn" ]}, "Protocol"  : "lambda" }
        ],
       "TopicName" : "dev-autoscaling-NotificationTopic"
      }
    },      

    "LambdaInvokePermission": {
        "Type": "AWS::Lambda::Permission",
        "Condition": "IsUSWest2",
        "DependsOn" : [ "LambdaDNS", "autoscalingNotificationTopic" ], 
        "Properties": {
          "Action": "lambda:InvokeFunction",
          "Principal": "sns.amazonaws.com",
          "SourceArn": { "Ref": "autoscalingNotificationTopic" },
          "FunctionName": { "Fn::GetAtt": [ "LambdaDNS", "Arn" ] }
        }
    }
  .....
```