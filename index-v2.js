/*******************************************************************************  
* Lambda function which reacts to SNS topics about Autoscaling events.
* Assumptions:
* - SNS topic for autoscaling
* - Topcic events of autoscaling:EC2_INSTANCE_LAUNCH and autoscaling:EC2_INSTANCE_TERMINATE
* - Autoscaling object has these tags: 
* 	- name:  'Route53'
* 	- value: 'HostedZoneId:record-name (e.g. www.example.com)'

* 
*	informed by: https://github.com/30mhz/autoscaling-route53-lambda
*
*
*
********************************************************************************/

var AWS = require('aws-sdk');
var async = require('async');

// process.stdin.resume();
// process.stdin.setEncoding('utf8');
// process.stdin.on('data', function(data) {
exports.handler = function(event, context) {
	console.log("info: event received " + JSON.stringify(event));

	var message = JSON.parse(event.Records[0].Sns.Message);
	// var message = JSON.parse(data);
	var name = message.AutoScalingGroupName;
	var id = message.EC2InstanceId;
	var event = message.Event;
	// var awsRegion = message.awsRegion;

	console.log("info: message: name=" + name + " id=" + id + " event=" + event);

	var autoscaling = new AWS.AutoScaling({
		region: 'eu-west-1'
	});
	var ec2 = new AWS.EC2({
		region: 'eu-west-1'
	});
	var route53 = new AWS.Route53();

	async.waterfall([
		function describeTags(next) {
			autoscaling.describeTags({
				Filters: [{
					Name: "auto-scaling-group",
					Values: [
						name
					]
				}, {
					Name: "key",
					Values: ['Route53']
				}],
				MaxRecords: 1
			}, next);
		},
		function processTags(response, next) {
			if (response.Tags.length == 0) {
				next("ASG: " + name + " does not define Route53 DomainMeta tag.");
			}
			var tokens = response.Tags[0].Value.split(':');
			var route53Tags = {
				HostedZoneId: tokens[0],
				RecordName: tokens[1]
			};
			next(null, route53Tags);
		},
		function retrieveInstanceIds(route53Tags, next) {
			ec2.describeInstances({
				DryRun: false,
				InstanceIds: [id]
			}, function(error, data) {
				try {
					var batch = {
						ChangeBatch: {
							Changes: [{
								Action: 'UPSERT',
								ResourceRecordSet: {
									Name: route53Tags.RecordName,
									Type: 'CNAME',
									SetIdentifier: id,
									Weight: 10,
									TTL: 1,
									ResourceRecords: [{
										Value: data.Reservations[0].Instances[0].NetworkInterfaces[0].Association.PublicDnsName
									}]
								}
							}]
						},
						HostedZoneId: route53Tags.HostedZoneId
					};
					next(error, batch);
				} catch(e) {
					// if the instance doesn't have an Association anymore it is already terminated (or terminating)
					route53.listResourceRecordSets({
						HostedZoneId: route53Tags.HostedZoneId,
						MaxItems: '1',
						StartRecordName: route53Tags.RecordName,
						StartRecordIdentifier: id,
						StartRecordType: 'CNAME'
					}, function(listError, resourceRecordSets) {
						if(listError) {
							console.log('listError', listError);
						} else {
							var batch = {
								ChangeBatch: {
									Changes: [{
										Action: 'DELETE',
										ResourceRecordSet: {
											Name: route53Tags.RecordName,
											Type: 'CNAME',
											SetIdentifier: id,
											Weight: 10,
											TTL: 1,
											ResourceRecords: [{
												Value: resourceRecordSets.ResourceRecordSets[0].ResourceRecords[0].Value
											}]
										}
									}]
								},
								HostedZoneId: route53Tags.HostedZoneId
							};
							next(listError, batch);
						}
					});
				}
			});
		}
	], function(error, batch) {
		if (error) {
			console.error(error);
		} else {
			if (event === "autoscaling:EC2_INSTANCE_LAUNCH") {
				batch.ChangeBatch.Changes[0].Action = 'UPSERT'
			} else if (event === "autoscaling:EC2_INSTANCE_TERMINATE") {
				batch.ChangeBatch.Changes[0].Action = 'DELETE'
			} else {
				console.log ("warning: received unexpected message, ignoring: " + event);
				return;
			}

			// now do the work
			route53.changeResourceRecordSets(batch, function(error, response) {
				if(error) { console.log(error) }
				console.log(response);
			});
		}
	});
};