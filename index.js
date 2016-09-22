/*******************************************************************************  
* Lambda function which reacts to SNS topics about Autoscaling events.
* Assumptions:
* - SNS topic for autoscaling
* - Topcic events of autoscaling:EC2_INSTANCE_LAUNCH and autoscaling:EC2_INSTANCE_TERMINATE
* - Autoscaling object has these tags: 
* 	- name:  'Route53' (defined in tagName variable)
* 	- value:  <three options>
* 		1) 'HostedZoneId:record-name' 			Ex. Z1473BHDWSM6GV:www.example.com 				(assumes CNAME type and TTL of 1)
* 		2) 'HostedZoneId:type:record-name'  	Ex. Z1473BHDWSM6GV:CNAME:www.example.com 		(assumes TTL of 1)'
* 		3) 'HostedZoneId:type:record-name:ttl'  Ex. Z1473BHDWSM6GV:CNAME:www.example.com:30)'	
* 		4) <empty string> or value of 'none' are ignored

* 	 By Peter R Jones https://github.com/PeterRJones/
*	 Heavily influenced by: https://github.com/30mhz/autoscaling-route53-lambda
*
* TODO:
* - how to allow for hosted zone name as well as id. ex: example.com:CNAME:www.example.com
* - support latency routing policies http://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html?console_help=true#routing-policy-latency
* - tie into git, jenkins and lambda versioning
*
********************************************************************************/
"use strict";


var AWS 			= require('aws-sdk');
var async 			= require('async');
var AWS_REGION  	= process.env.AWS_REGION || 'us-west-2' ;	
var tagName			= 'Route53';
var typeRegEx		= /A|CNAME/;
var nDNSWeight		= 10;
var defaultTTL  	= 1;
var defaultRecType 	= 'CNAME';


exports.handler = function(inEvent, context) {

	console.log("info: function: " + context.functionName + " version: " + context.functionVersion + " AWS_REGION: " + AWS_REGION + " SNS-message-received: " + JSON.stringify(inEvent));

	var message = JSON.parse(inEvent.Records[0].Sns.Message);
	var event 	= message.Event;
	var name 	= message.AutoScalingGroupName;
	var cause 	= message.Cause;

	var useDNSNames 	= false;
	var isPrivate		= false;

	var route53Tags = {
			HostedZoneId: '',
			Type: 		  defaultRecType,
			RecordName:   '',
			TTL: 		  defaultTTL
		};


	// short-circut for test messages and others we don't care about
	// 
	if ( ! ((event === "autoscaling:EC2_INSTANCE_LAUNCH") || (event === "autoscaling:EC2_INSTANCE_TERMINATE")) ) {
		console.log ("info: ignoring message: " + event + " for AutoScalingGroupName: " + name);
		return;
	}

	// assume EC2 launch and terminate message only from here on
	var idEC2Instance = message.EC2InstanceId;

	console.log("info: AWS_REGION: " + AWS_REGION + " Autoscaling-Event:" +  event + " for AutoScalingGroupName: " + name + " cause: " + cause);

	var autoscaling = new AWS.AutoScaling({
		region: AWS_REGION
	});
	var ec2 = new AWS.EC2({
		region: AWS_REGION
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
					Name: 	"key",
					Values: [tagName]
				}],
				MaxRecords: 1
			}, next);
		},
		function processTags(response, next) {
			if (response.Tags.length === 0 || response.Tags[0].Value.length === 0 || response.Tags[0].Value == "none") {
				next("Warning: Ignoring message. ASG: " + name + " does not define tag: '" + tagName + "' or tag value is empty or 'none'.");
				return;
			}

			console.log("info: response: " + JSON.stringify(response));
			var tokens = response.Tags[0].Value.split(':');

			// three format options resulting in array of 2, 3 or 4 elements. See syntax notes in comments at top
			if (tokens.length === 0 || tokens.length > 4) {
				next("Error: ASG: " + name + " tag: '" + tagName + "' have too few or too many separators : (expecting 2 or 3). 'HostedZoneId:record-name' (assume type CNAME) or 'HostedZoneId:type:record-name' .");
				return;
			}

			// set HostedZoneId
			route53Tags.HostedZoneId = tokens[0];
			
			
			if (tokens.length >= 3) {
				// validate type parameter
				if (tokens[1].match(typeRegEx) === null) {
					next("Error: ASG: " + name + " tag: '" + tagName + "' has invalid type field (expecintg " + typeRegEx.toString() + "). Received value: '" + response + "'' .");
					return;
				} else {
					route53Tags.Type 	   = tokens[1];	
				}

				route53Tags.RecordName = tokens[2]; 

				if (tokens.length === 4) {
					// validate ttl parameter
					var newTTL = parseInt(tokens[3]);
					if (isNaN(newTTL)) {
						next("Error: ASG: " + name + " tag: '" + tagName + "' has invalid ttl value (expecintg valid integer). Received value: '" + response + "'' .");	
						return;	
					} else {
						route53Tags.TTL = newTTL;
					}
				}

			} else {	// 2 parameter case
				route53Tags.RecordName =  tokens[1];
			}

			// determine if we want ips or dns names based on records type; A=ip, CNAME=dns
			if (route53Tags.Type == "A") {
				useDNSNames = false;
			}
			else {
				useDNSNames = true;	
			}
			
			next(null, route53Tags);
		},
		function inspectDNSZone(route53Tags, next) {
			// Look at DNS zone to see if its public or private
			route53.getHostedZone({ Id: route53Tags.HostedZoneId }, next);
		},
		function processDNSInfo(data, next) {
			
			console.log("info: inspectdDNSZone data: " + JSON.stringify(data));
			// if(getZoneError) {
			// 	console.log('getZoneError', getZoneError);
			// 	next(getZoneError);
			// } else {
				// Determine if we are internal or public zone and set isPrivate accordingly
				isPrivate = data.HostedZone.Config.PrivateZone;
			// }

			next(null, route53Tags);
		},
		function retrieveInstanceIds(route53Tags, next) {
			ec2.describeInstances({
				DryRun: false,
				InstanceIds: [idEC2Instance]
			}, function(error, data) {
				try {
					console.log("info: retrieveInstanceIds data: " + JSON.stringify(data));

					var recordValue = 0;
					if( isPrivate ) {
						// use private ips or names
						if( useDNSNames ) {
							recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddresses[0].PrivateDnsName;
						}
						else {
							recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddresses[0].PrivateIpAddress;
						}

					} else {
						// use public ips or names
						if( useDNSNames ) {
							recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].Association.PublicDnsName;
						}
						else {
							recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].Association.PublicIp;
						}
					}


					var batch = {
						ChangeBatch: {
							Changes: [{
								Action: 'UPSERT',
								ResourceRecordSet: {
									Name: 			route53Tags.RecordName,
									Type: 			route53Tags.Type,
									SetIdentifier: 	idEC2Instance,		// id of EC2 instance 
									Weight: 		nDNSWeight,
									TTL: 			route53Tags.TTL,
									ResourceRecords: [{
										Value: recordValue
									}]
								}
							}]
						},
						HostedZoneId: route53Tags.HostedZoneId
					};

					console.log("info: Route53 UPSERT with " + JSON.stringify(batch));
					next(error, batch);
				} catch(e) {
					// if the instance doesn't have an Association anymore it is already terminated (or terminating)
					route53.listResourceRecordSets({
							HostedZoneId: 			route53Tags.HostedZoneId,
							MaxItems: 				'1',
							StartRecordName: 		route53Tags.RecordName,
							StartRecordIdentifier: 	idEC2Instance,	// id of EC2 instance 
							StartRecordType: 		route53Tags.Type,
					}, function(listError, resourceRecordSets) {
						if(listError) {
							console.log('listError', listError);
						} else {
							var batch = {
								ChangeBatch: {
									Changes: [{
										Action: 	'DELETE',
										ResourceRecordSet: {
											Name: 			route53Tags.RecordName,
											Type: 			route53Tags.Type,
											SetIdentifier: 	idEC2Instance,		// id of EC2 instance 
											Weight: 		nDNSWeight,
											TTL: 			route53Tags.TTL,
											ResourceRecords: [{
												Value: resourceRecordSets.ResourceRecordSets[0].ResourceRecords[0].Value
											}]
										}
									}]
								},
								HostedZoneId: 	route53Tags.HostedZoneId
							};
							console.log("info: Route53 DELETE with " + JSON.stringify(batch));
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
				batch.ChangeBatch.Changes[0].Action = 'UPSERT';
			} else if (event === "autoscaling:EC2_INSTANCE_TERMINATE") {
				batch.ChangeBatch.Changes[0].Action = 'DELETE';
			} else {
				console.log ("error: received unexpected message, exiting. event: " + event);
				return;
			}

			console.log("Calling changeResourceRecordSets with batch: " + JSON.stringify(batch));
			// now start the work
			route53.changeResourceRecordSets(batch, function(error, response) {
				if(error) { 
					console.log(error); 
				} else {
					console.log("Success: " + JSON.stringify(response));	
				}
			});
		}
	});
};