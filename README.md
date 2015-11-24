# autoscaling-route53-lambda
This code can be used to manage Route53 CNAME from Autoscaling Group with Lambda. The main function listens for TERMINATE and LAUNCH events, and DELETEs and UPSERTs records to Route53.

## ZIP it up
Create ZIP file with `zip ../autoscaling-route53.js index.js async`

## Install (for lack of better words)
AWS makes this relatively easy for you, but you still have to jump some hoops. Let's use the Console for this, as it is easiest. First select the Autoscaling Group you want to 'sync' with Route53

1. create an IAM role with policies AmazonEC2ReadOnlyAccess, CloudWatchLogsFullAccess and AmazonRoute53FullAccess (our name is AutoscalingRoute53Role)
1. create a Lambda function with ZIP and IAM Role from before (our name is autoscalingRoute53)
1. create an SNS topic (our topic name asg-notifications-staging-elasticsearch-30mhz-com)
1. add a subscription to SNS topic, pointing to the Lambda function
1. on the notifications tab in the details pane of the Autoscaling Group you click 'Create notification'
1. set 'send notification to' to the SNS topic
1. and make sure only 'launch' and 'terminate' are checked
1. last, but not least, add a tag to the Autoscaling Group with key 'Route53' and value 'HostedZoneId:record-name'

And now, scale :)


