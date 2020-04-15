/*
 * IOTA PAY - Payment server 
 * 
 * 
 * 	communication with wallet server
 * 
 *  
 * */


var request = require('request');


var url_walletserv = "http://localhost:11000";


var _sendRequest = function(send_json, callback_finished)
{
	try
	{
		request.post(url_walletserv, {json: true, body: send_json}, (err, res, body) => {
			try
			{ 
			
				if (!err && res.statusCode === 200) 
				{
					callback_finished(body);			
				}else{
					console.log("wallet request error.");
					console.log(err);
					console.log(res);
					
					callback_finished({accepted:false, error:'wallet_comm communication error. No1'+err});
				}
			}catch(e)
			{
				callback_finished({accepted:false, error:'wallet_comm communication error. No02'+e});		
			}
		});	
	}catch(e)
	{
		callback_finished({accepted:false, error:'wallet_comm communication error. No3'+e});		
	}
}

// callback(false) if OK else callback(error)
var sendFunds = function(address, amount, callback = function(err){})
{
	_sendRequest({request:'sendTransfer', address:address, amount:amount }, function(retval){
		
		try
		{
			if(retval.accepted == true)
			{
				callback(false);	// No error occurred
			}else{
				console.log('Error occurred requesting sendFunds.');
				callback(retval);
			}
		}catch(e)
		{
			console.log("ERROR occurred requesting sendFunds:", e);
			callback(e);
		}
	});
}

// callback(address) or callback(false) if error
var getNewMonitoredAddress = function(callback)
{
	_sendRequest({request:'getMonitoredAddress' }, function(retval){
		
		try
		{			
			if(retval.accepted == true)
			{
				callback(retval.address);	// No error occurred
			}else{
				console.log('Error occurred requesting sendFunds.', retval);
				callback(false);
			}
		}catch(e)
		{
			console.log("ERROR occurred requesting sendFunds:", e);
			callback(false);
		}
	});	
}

// callback (balance), balance === false if error
var checkAddressBalance = function(address, callback)
{
	_sendRequest({request: 'checkAddressBalance', address: address }, function(retval){
		
		try
		{			
			if(retval.accepted == true)
			{
				callback(retval.balance);		// No error occurred
			}else{
				console.log('Error occurred requesting sendFunds.', retval);
				callback(false);
			}
		}catch(e)
		{
			console.log("ERROR occurred requesting sendFunds:", e);
			callback(false);
		}
	});		
}

// callback (balance), balance === false if error
var checkAddressBalanceUnconfirmed = function(address, callback)
{
	_sendRequest({request: 'checkAddressBalanceUnconfirmed', address: address }, function(retval){
		
		try
		{			
			if(retval.accepted == true)
			{
				callback(retval.balance);		// No error occurred
			}else{
				console.log('Error occurred requesting sendFunds.', retval);
				callback(false);
			}
		}catch(e)
		{
			console.log("ERROR occurred requesting sendFunds:", e);
			callback(false);
		}
	});		
}

// callback (accepted)
var sendBundles = function(bundles, reattach, callback)
{
	_sendRequest({request: 'sendBundles', bundles: bundles, reattach:reattach }, function(retval){
		
		try
		{			
			if(retval.accepted == true)
			{
				callback(true);		// No error occurred
			}else{
				console.log('Error occurred requesting sendFunds.', retval);
				callback(false);
			}
		}catch(e)
		{
			console.log("ERROR occurred requesting sendFunds:", e);
			callback(false);
		}
	});		
}


module.exports = {
	'sendFunds': sendFunds,
	'getNewMonitoredAddress': getNewMonitoredAddress,
	'checkAddressBalance': checkAddressBalance,
	'checkAddressBalanceUnconfirmed': checkAddressBalanceUnconfirmed,
	'sendBundles' : sendBundles
}



