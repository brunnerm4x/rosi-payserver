/*
 * ROSI - Payment server 
 * 
 * 
 * 	flashchannel
 * 
 * 
 * 	listens on port 9000
 * 
 * 
 * 		ATTENTION: 		Comments with DTOF == Differences to original flash 
 * 
 * 					Added an addional layer: the deposit address is now different from 
 * 						the flash tree root, this means:
 * 
 * 							-> 1 additional multisig address (deposit)
 * 							-> 1 additional field in flash object for this new address & bundles (depositObject)
 * 							-> 1 additional transaction when channel is started (from deposit to root)
 * 							-> while channel active, everything is like in original library
 * 							-> when channel closes, an additional/different to normal bundle is crated (2nd outgoing transaction from deposit):
 * 									=> the closing bundle which takes input from deposit address (outputs are same as original)
 * 									=> the original closing transaction can also be crated, but is not planned to be used (more addional bundles down the tree would be necessary to be attached
 * 							
 * 						=> atvantage: only one bundle to be attached to tangle when channel is closed normally (without desputes)  
 * 
 * */
 

"use strict";

let PORT = 9000;
let VERSION = "ROSI PAYSERVER";
let ALLOWED_UNCONFIRMED_BALANCE = 100;			// How much iota is the user allowed to spend
												// in a channel with no confirmed deposit
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const multisig = require('iota.flash.js').multisig;
const transfer = require('iota.flash.js').transfer;

var wallet_comm = require('./wallet_comm.js');

const IOTA = require('iota.lib.js');
var iota = new IOTA();

// System Constants
const ALLOWED_SEED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ9";
const IOTA_SECURITY = 2;
												
var unclaimedPayments = [];				// [{channelId, balance}, ...] list of credit on channelIds


//////////////////////   USE ENVIRONMENT VARIABLES IF AVAILABLE		////////////////////////////////

if(typeof process.env.npm_package_config_port != "undefined")
{
	PORT = parseInt(process.env.npm_package_config_port);	
	console.log("Using Environment Variable for PORT, value: " + PORT);
}
if(typeof process.env.npm_package_version != "undefined")
{
	VERSION = process.env.npm_package_version;
	console.log("Using Environment Variable for VERSION, value: " + VERSION);
}
if(typeof process.env.npm_package_config_allowedUnconfirmed != "undefined")
{
	ALLOWED_UNCONFIRMED_BALANCE = parseInt(process.env.npm_package_config_allowedUnconfirmed);	
	console.log("Using Environment Variable for ALLOWED_UNCONFIRMED_BALANCE, value: " + 
					ALLOWED_UNCONFIRMED_BALANCE);
}



// Get new monitored Address before continuing with creation of channel...
var createChannel = function(recbuffer, response)
{
	wallet_comm.getNewMonitoredAddress((address)=>{
		
		if(address === false)	// on error
		{
			// Respond to client
			var create_channel_data = {
				accepted: false,
				error: 'Cannot get a new wallet address.'
			}
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify(create_channel_data));
			return;
		}
		
		createChannelContinue(recbuffer, response, address);
	});
}

// Create new channel, multisigs, save to file, response to client
var createChannelContinue = function(recbuffer, response, newMonitoredAddress)
{
	var flash = createFlashObject();
		flash.tree_depth = recbuffer.tree_depth;				// user sets tree depth
		flash.balance = recbuffer.balance;
		flash.deposits[0] = recbuffer.balance;					// user deposits all
		flash.settlementAddresses[0] = recbuffer.settlement; 	// set user settlement address
		flash.settlementAddresses[1] = iota.utils.noChecksum(newMonitoredAddress);

	
	// Create digests for the start of the channel
	var digests = [];
	digests[0] = recbuffer.digests;
	digests[1] = [];
	var numDigest = Math.pow(2, flash.tree_depth + 1);		// DTOF: +1 (removed -1) multisig for new deposit address
	
	let i;
	for (i = flash.multisig_digest_inx; i <= digests[0].length + flash.multisig_digest_inx -1 && i <= numDigest; i++)
	{
	  digests[1].push(multisig.getDigest(flash.seed, i, IOTA_SECURITY));
	}
	// Set new index value
	flash.multisig_digest_inx = i;
	
	// Connect with client
	// receive: 
	//		-> settlement Address user
	//		-> tree depth
	//		-> amount of collateral (balance)
	//		-> partial digests (created above) for user
	// send (if no error):
	// 		<- settlement address service provider
	//		<- partial digests from service provider
	//	
	// Format (body, both directions): json
	var create_channel_data = {
		accepted: true,
		settlement: flash.settlementAddresses[1],
		digests: digests[1]
	}
	// Respond to client
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify(create_channel_data));

	let multisigs = digests[1].map((digest, index) => {

	  // Create address
	  let addy = multisig.composeAddress(
		digests.map(userDigests => userDigests[index])	// -> [digests[0][index], digests[1][index]]
	  )
	  // Add key index in
	  addy.index = digest.index; 
	  // Add the signing index to the object IMPORTANT
	  addy.signingIndex = digest.security;	// flashObj.userIndex * digest.security --> flash.userIndex = 1
	  // Get the sum of all digest security to get address security sum
	  addy.securitySum = digests
		.map(userDigests => userDigests[index])
		.reduce((acc, v) => acc + v.security, 0)
	  // Add Security
	  addy.security = digest.security

	  return addy
	  
	});

	// Set remainder address (Same on both users)
	flash.remainderAddress = multisigs.shift();		// multisigs index 0
	flash.depositObject = multisigs.shift();		// DTOF: deposit is multisigs index 1
	flash.depositAddress = iota.utils.addChecksum(flash.depositObject.address);			// DTOF: get deposit not from flash root
	
	let initial_multisigs = multisigs.slice(0, flash.tree_depth + 1);
	flash.multisig_digest_pool = multisigs.slice(flash.tree_depth + 1);
	
	// Nest initial tree
	for (let i = 1; i < initial_multisigs.length; i++)
	{
	  initial_multisigs[i - 1].children.push(initial_multisigs[i]);
	}
	
	flash.root = initial_multisigs.shift();			// multisigs index > 1

	// Save fully initialized flash object to disk
	fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
	
	console.log("Setup finished, deposit Address:", flash.depositAddress);
	console.log("Now waiting for request to transfer from deposit to root.");
}


// Create Flash Object with secure new seed and return this object
var createFlashObject = function()
{
	// Define flash object, 
	// when array for both user and service provider, user is index 0, serv. is index 1!
	var flash = {
		seed: "",								// Channel seed, new one for every session!
		multisig_digest_inx: 0,
		multisig_digest_pool: [],
		tree_depth:0,
		signersCount: 2, 						// Number of signers in a channel
		balance: 0, 							// total channel balance
		balance_unconfirmed_allowed: false,		// A bit of the balance is allowed to be used before confirmation of deposit
		balance_confirmed: false,				// Has deposit really been transferred and confirmed on tangle?
		deposits: [0,0], 						// individual user deposits 
		settlementAddresses: [], 				// user's output addresses
		depositAddress: "",						// Address at index 1 with checksum	
		depositObject: {},						// DTOF: Deposit address bundles and data	
		remainderAddress: "", 				    // Index 0 of the multisig addresses generated
		root: {},								// Index 1+ of the multisig addresses generated
		outputs: {},							// Channel's output history 
		transfers: [] 							// History of transfers within the channel
	};
	

	// Generate new seed for flash channel 
	crypto.randomBytes(81).forEach((value) => { 
		while(value > 243){ 		// against 'modulo biasing'
			value = crypto.randomBytes(1)[0]; 
		} 
		flash.seed += ALLOWED_SEED_CHARS.charAt(value%27); 
	});

	return flash;
}


// --- Opening or closing bundle ---
// Take bundle from message, check it and then sign and return back
// bundle should be transfer from deposit address to root of flash tree or fromm deposit to users
var receiveSpecialBundle = function(recbuffer, response)
{
	try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + recbuffer.depositAddress));
	}catch(e){
		console.log("ERROR: cannot continue channel", recbuffer.depositAddress, ". No flash object file found.");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}
	
	let request = recbuffer.action;
	let bundle = recbuffer.bundle;
	let inputAddress = flash.depositObject.address;
	let key = iota.multisig.getKey(flash.seed, flash.depositObject.index, IOTA_SECURITY);
	
	
	//// Everything cleared - precede by creating the requested signatures
	let createSignatures = () => 
	{
		iota.multisig.addSignature(bundle, inputAddress, key, function(err, suc)
		{
			if(!err)
			{
				console.log('Bundle signed.');
				// check bundle integrity/signatures
				if(iota.utils.validateSignatures(suc, iota.utils.noChecksum(flash.depositAddress)) == false)
				{
					console.log('ERROR: Bundle has not passed signature check!');
					response.writeHead(200, {'Content-Type': 'application/json'});
					response.end(JSON.stringify({accepted:false, error:' Bundle has not passed integrity check!'}));
					return;
				}
				// Add bundle to flash object
				flash.depositObject.bundles.push(suc);
				// Save to file
				fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));

				if(request == 'closeChannel')
				{
					wallet_comm.sendBundles([suc], true, (s)=>{ if(!s) console.log('Error occurred when attaching final bundle to tangle!'); });
				}
				
				// Response to client
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:true, signedBundles: suc}));
				return 0;
			}
			else
			{
				console.log('Error occurred when signing bundle.');
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:false, error:'Error when signing bundle.'}));
				return 0;
			}
		});
	}
	
	
	if(request == 'depositToRoot')
	{
		// Check if deposit has already been sent
		if(flash.depositObject.bundles.length !== 0)
		{
			console.log('ERROR: Flash deposit already sent! (Bundles.length != 0)');
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({accepted:false, error:'Flash deposit already sent! (Bundles.length != 0)'}));
			return;
		}
		// Check bundle in and outputs
		let inputs = bundle.filter(transaction => transaction.value < 0);
		let outputs = bundle.filter(transaction => transaction.value > 0);
		
		if(inputs.length != 1 || outputs.length != 1 || 
			inputs[0].address != iota.utils.noChecksum(flash.depositAddress) ||
			outputs[0].address != flash.root.address ||
			inputs[0].value != (-1)*flash.balance || outputs[0].value != flash.balance)
		{
			console.error('ERROR: Bundle has invalid inputs/outputs!');
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({accepted:false, error:' Bundle has invalid inputs/outputs!'}));
			return;
		}
		
		// Continue with creation
		createSignatures();	
	}
	else if(request == 'closeChannel')
	{
		// Balance has been retrieved (see below)
		let createBundles = (balance) => 
		{
			// Check if deposit has already been sent
			if(flash.depositObject.bundles.length !== 1)
			{
				console.warn('WARNING: Flash deposit to root has not happened yet!');
			}
			
			// check bundle inputs/outputs
			let inputs = bundle.filter(transaction => transaction.value < 0);
			let inBalance = inputs.reduce((acc, tx) =>  acc - tx.value, 0);	// values are negative
			let outputs = bundle.filter(transaction => transaction.value > 0);
			let outProv = outputs.filter(output => output.address == 
					iota.utils.noChecksum(flash.settlementAddresses[1])).reduce((acc, tx) => acc + tx.value, 0);
			let outProvOK = flash.balance - flash.deposits.reduce((acc, val)=> acc+val);
			
			if(balance != inBalance)
			{
				console.error('ERROR: Proposed Bundle inputs are higher than current balance of deposit Address!');
				
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:false, error:'Balance flash OK but higher than real.'}));
				return;
			}

			if(inputs[0].address != iota.utils.noChecksum(flash.depositAddress) ||
				outProv != outProvOK)
			{
				console.error('ERROR: Bundle has invalid inputs/outputs!');
				
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:false, error:' Bundle has invalid inputs/outputs!'}));
				return;
			}
			
			// OK - Continue with creation
			createSignatures();	
		}
		
		// START HERE
		// Get current deposit address balance to check if everything is still fine
		wallet_comm.checkAddressBalance(flash.depositAddress, (balance) =>
		{
			if(balance >= flash.balance)
			{
				// continue ... 
				createBundles(balance);
				return;
			}
			else
			{
				// Not enough channel balance -> this is probably fraud!!
				console.error('ERROR: BALANCE OF DEPOSIT ADDRESS IS INVALID!');
			
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:false, error:'Balance of DEPOSIT address INVALID!'}));
				return;
			}
		});
	}
	else
	{
		console.log('Unknown request!');
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'ACTION_UNKNOWN'}));
		return;
	}

}

// cb_payment_received(amount, channelRemainingBalance) callback function is only called when payment was accepted and flash
// object was updated, amount is amount sent to receiver (other direction payment not possible)
var receivePayment = function(recbuffer, response, cb_payment_received)
{
	try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + recbuffer.depositAddress));
	}catch(e){
		console.error("ERROR: cannot continue channel", recbuffer.depositAddress, ". No flash object file found.");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}
	
	// Check if channel opening bundle has been received (transfer from deposit to root)
	if(flash.depositObject.bundles.length < 1)
	{
		console.error('ERROR: Deposit to flash root has not happened yet, channel is not correctly initialized!');
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Deposit to flash root has not happened yet, channel is not correctly initialized!'}));
		return;
	}
	
	if(flash.balance_confirmed != true)
	{
		// Check if it has already been transferred an confirmed...
		wallet_comm.checkAddressBalance(flash.depositAddress, (balance)=>{
				if(balance >= flash.balance)
				{
					// Set confirmed now
					flash.balance_confirmed = true;
					// Safe to file
					fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
					
					// Continue
					receivePaymentContinue(flash, recbuffer, response, cb_payment_received);
					return;
				}else if(ALLOWED_UNCONFIRMED_BALANCE > 0 && flash.balance_unconfirmed_allowed === false){
					wallet_comm.checkAddressBalanceUnconfirmed(flash.depositAddress, (balance)=>{
						if(balance == flash.balance)
						{
							// Allow usage of unconfirmed, but published on tangle balance
							flash.balance_unconfirmed_allowed = ALLOWED_UNCONFIRMED_BALANCE;
							receivePaymentContinue(flash, recbuffer, response, cb_payment_received);
						}else{
							response.writeHead(200, {'Content-Type': 'application/json'});
							response.end(JSON.stringify({accepted:false, error:'No acceptable (unconfirmed) balance available.'}));
							return;
						}
					});
					return;
				}else if(flash.balance_unconfirmed_allowed > 0){
					// Unconfirmed allowed balance is available
					receivePaymentContinue(flash, recbuffer, response, cb_payment_received);
					return;
				}else{
					// Has not been confirmed
					response.writeHead(200, {'Content-Type': 'application/json'});
					response.end(JSON.stringify({accepted:false, error:'Balance has not been confirmed.'}));
					return;
				}
		});
		return;
	}else{
		receivePaymentContinue(flash, recbuffer, response, cb_payment_received);
	}
}



//////////////////////// DEBUGGING 		////////////////////////////////////////

let findlastbundle = (node, bundleHash) => 
{
	if(node.bundles.filter(b => (b[0].bundle == bundleHash)).length > 0)
	{
		return node;
	}
	
	if(node.children.length == 0)
	{
		return false;
	}
	
	for(let i = 0; i < node.children.length; i++)
	{
		let cval = findlastbundle(node.children[i], bundleHash);
		if(cval != false)
			return cval;
	}
}

let findInputSourceNode = (node, searchAddr) => {
	
	if(node.bundles.filter(b => b.filter(tx => (tx.value > 10 && tx.address == searchAddr)).length > 0 ).length > 0)
	{
		return node;
	}
	
	if(node.children.length == 0)
	{
		return false;
	}
	
	for(let i = 0; i < node.children.length; i++)
	{
		let cval = findInputSourceNode(node.children[i], searchAddr);
		if(cval != false)
			return cval;
	}
}

let cleanRoot = (flash, bundleHashLastValid) => 
{
	console.log("hash:", bundleHashLastValid);
	let lastbundle = findlastbundle(flash.root, bundleHashLastValid);
	console.log("lastbundle:",lastbundle);
	let addr = lastbundle[0].address;
	let inx,linx,source;
	do
	{
		source = findInputSourceNode(flash.root, addr);
		inx = source.children.findIndex(tx => tx.address == addr) + 1;
		linx = source.children.length;
		
		console.log("delete:", source.children.splice(inx));
		console.log("deleted items cnt:", linx - inx);
	}while(inx != linx);
};


//////////////////////// DEBUGGING END 	////////////////////////////////

// continue, once balance availability has been checked...
// NEW channel close is ignored, bundle with more than one tx to provider is rejected!
var receivePaymentContinue = function(flash, recbuffer, response, cb_payment_received)
{
	var bundles = recbuffer.bundles;
	var signatures = [];
		signatures[0] = recbuffer.signature;	
	
	let message = recbuffer.message;	
		
	let toUse = multisig.updateLeafToRoot(flash.root)
	if (toUse.generate != 0) 
	{
		// Tell the server to generate new addresses, attach to the multisig you give
		console.log("Need to get", toUse.generate, "new multisigs for the tree.");
		
		let last_multisig = null;
		for( let i = 0; i < toUse.generate; i++) 
		{
			// check if digests are still available from pool
			if( flash.multisig_digest_pool.length == 0 ) 
			{
				console.log('ERROR: multisig pool: not enough multisigs available!');
				// This case should not be possible with honest client
				// Client has to add multisigs beforhand and therefore 
				// create them by calling increaseDigest_pool
				/*
				// Check if pool and index are consistent, recalculate current index height ...
				console.log("Cleaning root .... ");
				let bundleHash =  flash.transfers[flash.transfers.length - 1][0].bundle;
				cleanRoot(flash, bundleHash);
				
				let inx = 0;
				let cnt_children = function(node)
				{
					inx ++;
					node.children.forEach((c) => { cnt_children(c); });
				}
				cnt_children(flash.root);
				inx += 2;
				
				if(inx != flash.multisig_digest_inx)
				{
					console.log("multisig-inx seems incorrect. Correcting... old inx: ", 
						flash.multisig_digest_inx, "new inx:", inx);
					fs.writeFileSync("flash_objects/" + flash.depositAddress + ".bak_" + Date.now(), JSON.stringify(flash));
					flash.multisig_digest_inx = inx;
					
					fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
				}
				*/
					fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
				// respond to client ...
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({accepted:false, error:'not enough multisigs available.'}));
				return;
			}

			let new_multisig = flash.multisig_digest_pool.shift();
			console.log("Using new address from pool.");

			// chain branch
			if (last_multisig != null){
				new_multisig.children.push(last_multisig);
			}
			last_multisig = new_multisig;
		}
		toUse.multisig.children.push(last_multisig);
	}
		
	// Check proposed bundle
	var diffs;
	try
	{
		diffs = transfer.getDiff(flash.root, flash.remainderAddress, flash.transfers, bundles);
	}catch(e)
	{
		console.log('Error getting diffs:', e);
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false}));
		return;
	}
	
	// TODO: better detection of diffs
	if((diffs.length == 1 &&  diffs[0].address.substring(0,81) == flash.settlementAddresses[1].substring(0,81)))
	{
		// Check if using unconfirmed balance
		if(flash.balance_confirmed != true && diffs[0].value > flash.balance_unconfirmed_allowed)
		{
			console.log('Not enough allowd unconfirmed balance available');
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({accepted:false, error:"not enough unconfirmed balance"}));
			return;
		}else if(flash.balance_confirmed != true){
			flash.balance_unconfirmed_allowed -= diffs[0].value;
		}
	
		console.log("Bundle accepted.");
		// Bundle is accepted -> generate signatures
		signatures[1] = transfer.sign(flash.root, flash.seed, bundles);
		
		
		// Sign the bundle
		var signedBundles = transfer.appliedSignatures(bundles, signatures[0]);
		signedBundles = transfer.appliedSignatures(signedBundles, signatures[1]);
	
		var amount = diffs[0].value;
		
		let tfnew = signedBundles[signedBundles.length -1];
		if(amount == 0 && flash.transfers.filter(tfold => {
				for(let i = 0; i < tfold.length && i < tfnew.length; i++)
				{
					if(	tfold[i].address != tfnew[i].address  ||
						tfold[i].value != tfnew[i].value  )
							return false;
				}
				
				return true;
			}).length > 0)
		{
			console.log("Found old transaction.");
			// Old transfer
		}
		else
		{
			try
			{
				// Apply bundles, update flash object
				transfer.applyTransfers(flash.root,			// Representation of the current state of the Flash tree
										flash.deposits,		// The amount of iotas still available to each user to spend from
										flash.outputs,		// The accrued outputs through the channel
										flash.remainderAddress,	//The remainder address of the Flash channel
										flash.transfers,	//  Transfer history of the channel
										signedBundles);		// Signed bundle
										
				console.log("Transfers applied.");
			}
			catch(e)
			{
				console.error("Error applying Transfers:" + e);
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({	accepted: false,
												error: "Error applying Transfers:" + e
									}));
				return;
			}
		}
		
		console.log("Available Funds in channel:", flash.deposits.reduce((acc, v) => acc + v));
		
		if(typeof flash.reverted != 'undefined' && flash.reverted.length > 0)
		{
			// There has been a revertion on this channel before, this must be the reissue of 
			// the old transaction -> do not add this payments to funds !!
			
			console.log("This transaction finishes a REVERT - RESTORE Process.");
			
			if(amount == flash.reverted[0].amountToZero)
			{
				// OK 
				console.log("Transaction accepted. Real value of transaction is 0.");
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({	accepted: true,
												amount: 0,
												info: "Accepted reissue of reverted transaction",
										remaining: flash.deposits.reduce((acc, val) => acc+val, 0),
										signature: signatures[1]
									}));
									
				// delete revert info from flash object
				flash.reverted.shift();
									
				// Save updated, valid flash object to disk
				fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
			}
			else
			{
				// Do not accept!!
				console.warn("Transaction is of wrong amount - can not accept.");
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({	accepted: false,
												error: "Pending reverted transaction!"
									}));
			}
			return;
		}
		else
		{
			// Save updated, valid flash object to disk
			fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
			
			if(message)
				console.log("Received Payment with message:", message);
			
			if(typeof message.paymentReference != "undefined" && message.paymentReference == "DONATION")
			{
				console.log("Received Donation. Do not add this to unclaimed Payments.");
			}
			else
			{
				// Respond to client, transaction is accepted and applied
				unclaimedPayments[flash.depositAddress] = (typeof unclaimedPayments[flash.depositAddress] 
					== 'undefined' ? 0 : unclaimedPayments[flash.depositAddress]) + amount;
			}
			
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({	accepted: true,
											amount: amount,
											remaining: flash.deposits.reduce((acc, val) => acc+val, 0),
											signature: signatures[1]
										}));
			
			if(typeof cb_payment_received == 'function'){
				cb_payment_received(diffs[0].value, flash.deposits.reduce((acc, val) => acc+val, 0));
			}
		}
		return;
	}
	
	// Respond to client, transaction is not accepted
	console.log("Transaction declined.");
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({accepted:false}));
}


// Increase multisig digest pool to continue tree
var increaseDigest_pool = function(recbuffer, response)
{
	try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + recbuffer.depositAddress));	
	}catch(e){
		console.error("Cannot continue channel", recbuffer.depositAddress, ". No flash object file found.");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}
	
	let nosave = false;
	if(recbuffer.old_index < flash.multisig_digest_inx)
	{
		// old digest, client propably messed up database -> supply but dont save
		nosave = true;
		console.log("Creating digests with flag 'nosave'...");
	}
	else if(recbuffer.old_index != flash.multisig_digest_inx)
	{
		console.error("Old index is not correct");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Old index is not correct!'}));
		return 0;
	}
	
	// Create digests
	var digests = [];
	digests[0] = recbuffer.digests;
	digests[1] = []
	
	var numDigest = Math.pow(2, flash.tree_depth + 1) - 1;
	
	let i;
	for (i = recbuffer.old_index; i <= digests[0].length -1 + recbuffer.old_index  && i <= numDigest; i++) 
	{
	  digests[1].push(multisig.getDigest(flash.seed, i, IOTA_SECURITY));
	}
	
	if(!nosave)
		flash.multisig_digest_inx = i;
	
	
	// continue creating multisigs
	let multisigs = digests[1].map((digest, index) => {

		// Create address
		let addy = multisig.composeAddress(
				digests.map(userDigests => userDigests[index])	// -> [digests[0][index], digests[1][index]]
			)
			// Add key index in
			addy.index = digest.index; 
			// Add the signing index to the object IMPORTANT
			addy.signingIndex = digest.security;	// flashObj.userIndex * digest.security --> flash.userIndex = 1
			// Get the sum of all digest security to get address security sum
			addy.securitySum = digests
			.map(userDigests => userDigests[index])
			.reduce((acc, v) => acc + v.security, 0)
			// Add Security
			addy.security = digest.security

			return addy

	});

	if(!nosave)
	{
		// add to flash object multisig pool
		flash.multisig_digest_pool = flash.multisig_digest_pool.concat(multisigs);
		
		// Save updated, valid flash object to disk
		fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
	}
	// Connect with client
	// receive: 
	//		-> settlement Address user
	//		-> partial digests (created above) for user
	// send (if no error):
	// 		<- settlement address service provider
	//		<- partial digests from service provider
	//	
	// Format (body, both directions): json
		// Exchange digests with server
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({	accepted: true,
									digests: digests[1]
								}));
}


// Send requested provider key to client to confirm authenticity
var sendProviderKey = function(recbuffer, response)
{
	try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + recbuffer.channelId));
	}catch(e){
		console.log("ERROR: cannot get provider key for channel", recbuffer.channelId, ". No flash object file found.");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}
	
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({ accepted:true, key:flash.root.address.slice(recbuffer.index, recbuffer.index + 20) }));
}


var sendDirectAddress = function(recbuffer, response)
{
	let txId = recbuffer.txId;		// Do something with this id...
	
	wallet_comm.getNewMonitoredAddress((address)=>{
		
		if(address === false)	// on error
		{
			// Respond to client
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({
					accepted: false,
					error: 'Cannot get a new wallet address.'
				}));
			return;
		}
		
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({	
			accepted: true,
			address: address
		}));
	});
}

var claimDeposit = function(recbuffer, response)
{
	let channelId = recbuffer.payID;	
	let amount = recbuffer.amount;
	
	if(typeof unclaimedPayments[channelId] == 'undefined')
	{
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({
				accepted: false,
				available: 0,
				error: 'UNKOWN_PAYID',
				payID: channelId
			}));
		return;
	}
	
	if(unclaimedPayments[channelId] < amount)
	{
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({
				accepted: false,
				available: unclaimedPayments[channelId],
				error: 'BALANCE_LOW',
				payID: channelId
			}));
		return;
	}
	
	unclaimedPayments[channelId] -= amount;
	
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({
			accepted: true,
			available: unclaimedPayments[channelId],
			payID: channelId
		}));
		
	return;
}

var transferDeposit = function(recbuffer, response)
{
	let channelIdFrom = recbuffer.payIDFrom;	
	let channelIdTo = recbuffer.payIDTo;	
	
	if(typeof unclaimedPayments[channelId] == 'undefined')
	{
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({
				accepted: false,
				error: 'UNKOWN_PAYID',
				payID: channelId
			}));
		return;
	}
	
	unclaimedPayments[channelIdTo] = (typeof unclaimedPayments[channelIdTo] == 'undefined' ? 
						0 : unclaimedPayments[channelIdTo])  + unclaimedPayments[channelIdFrom];
	
	unclaimedPayments[channelIdFrom] = 0;
	delete unclaimedPayments[channelIdFrom];
	
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({
			accepted: true,
			available: unclaimedPayments[channelIdTo],
			payID: channelIdTo,
			payIDFrom: channelIdFrom
		}));
	
	return;
}


// get paid balances of channelIds
var requestDepositBalance = function(recbuffer, response)
{
	let channelIds = recbuffer.payID;		// array of channelids
	let balances = [];
	
	channelIds.forEach((channelId, inx) => {
		balances[inx] = typeof unclaimedPayments[channelId] == 'undefined' ? 0 : 
																unclaimedPayments[channelId];
	});
	
	response.writeHead(200, {'Content-Type': 'application/json'});
	response.end(JSON.stringify({
			accepted: true,
			balances: balances
		}));
		
	return;
}


var calcualteDiffsTwoHistoryTransfers = function(bundle1, bundle2, settlementAddresses, deposits)
{
	let out1 = bundle1.filter(t => t.value > 0);
	let out2 = bundle2.filter(t => t.value > 0);
	
	let outputDiffs = settlementAddresses.map(addr => { 
			let v1 = out1.filter(t => t.address == addr);
			
			if(v1.length < 1){
				v1 = 0;
			}else{
				v1 = v1.reduce((a, v) => a + v.value, 0);
			}
				
			let v2 = out2.filter(t => t.address == addr);
			if(v2.length < 1){
				v2 = 0;
			}else{
				v2 = v2.reduce((a, v) => a + v.value, 0);
			}	
			
			return {
				address: addr,
				value: (v2 - v1)
			};
		});
		
	let totalDeposits = deposits.reduce((a,v) => a+v, 0);
	let factorDeposits = deposits.map(d => d/totalDeposits);
	let outputTotal = outputDiffs.reduce((a,c) => a+c.value, 0);
	let depositDiffs = factorDeposits.map(f => f * outputTotal);
	
	return {
		outputDiffs: outputDiffs,
		depositDiffs: depositDiffs
	};
}


// Deletes the last transaction from flash object -> ONLY DEBUGGING, NOT SECURE !!
var revertChannelState = function(flash)
{
	// Calculate output diffs ...
	let bundle2 = flash.transfers.pop();		// bundle2 == bundle to delete from history
	let bundle1 = flash.transfers[flash.transfers.length - 1];
	
	let diffs = calcualteDiffsTwoHistoryTransfers(	bundle1, 
													bundle2, 
													flash.settlementAddresses, 
													flash.deposits
												);
	let outputDiffs = diffs.outputDiffs;
	let depositDiffs = diffs.depositDiffs;
	
	for(let i = 0; i < outputDiffs.length; i++) 
	{
      if(outputDiffs[i].address in flash.outputs) 	// if not in outputs it should be 0 ... 
      {
        flash.outputs[outputDiffs[i].address] -= outputDiffs[i].value;
      }
    }
    
	flash.deposits = flash.deposits.map((d,i) => d + depositDiffs[i]);
	
	/*
	// now revert / clean flash.root ...
	console.log("Cleaning root ... ");
	try{
		console.log("Cleaning root ... ");
		cleanRoot(flash, bundle1[0].bundle);		// test before leaving in permanently!
	}catch(e){
		console.warn("new function cleanRoot does not work as espected: ", e);
	};
	*/
	
	// return the amount of transaction to user 1 -> provider => this calculation is designed for the use
	// in ROSI, the rest until here should work with every constellation.
		
	if(typeof flash.reverted == 'undefined')
		flash.reverted = [];
		
		
	let result = { 
		amountToZero : (outputDiffs.filter(d => d.address == flash.settlementAddresses[1])
							.reduce((a,v) => a+v.value,0) - depositDiffs[1]),
		deletedTransfer : bundle2
	}
	
	console.log("AmountToZero: ", result.amountToZero);
	
	flash.reverted.push(result);
	
	return result;
}


// get paid balances of channelIds
var revertFlashRequest = function(recbuffer, response)
{
	let channelId = recbuffer.channelId;
	
		try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + channelId));
			
			console.log("Received REVERT REQUEST. Creating backup of current state ...");
			fs.writeFileSync("flash_objects/" + flash.depositAddress + ".BAK_REVERT_" + Date.now(), JSON.stringify(flash));
			console.log("Now REVERTING FLASH OBJECT ...");
			let retval = revertChannelState(flash);
			console.log("REVERT finished. Saving new state...");
			
			// marking channel that next transaction is 0 value ...
			
			fs.writeFileSync("flash_objects/" + flash.depositAddress, JSON.stringify(flash));
			console.log("DONE.");
			
			response.end(JSON.stringify({
					accepted: true,
					amountToZero: retval.amountToZero,
					deletedTransfer : retval.deletedTransfer
				}));
			return;
						
	}
	catch(e)
	{
		console.log("ERROR: cannot continue channel", recbuffer.channelId, ". No flash object file found." + e);
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}		
	return;
}


// get paid balances of channelIds
var resolveIndexConflict = function(recbuffer, response)
{
	let channelId = recbuffer.channelId;
	let digest_index = recbuffer.digest_index;
	let transfers_length = recbuffer.transfers_length;
	
		try{
		// load channel flash object from file
		var flash = JSON.parse(fs.readFileSync("flash_objects/" + channelId));

			// client has more payments than server -> ??? -> remove packages from client 
			// -> probably gift for customer ;)
			if(transfers_length > flash.transfers.length)
			{
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({
					accepted: true,
					mode: 'revert',
					digest_index: flash.multisig_digest_inx,
					transfers_length: flash.transfers.length
				}));
				return;
			}
			else if(transfers_length < flash.transfers.length)
			{
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({
					accepted: true,
					mode: 'add',
					digest_index: flash.multisig_digest_inx,
					transfers_length: flash.transfers.length,
					transfer_objects: flash.transfers.slice(transfers_length - flash.transfers.length)
				}));
				return;
			}
			else
			{
				response.writeHead(200, {'Content-Type': 'application/json'});
				response.end(JSON.stringify({
					accepted: false,
					error: 'No need to change anything, Channel seems up-to-date.'
				}));
				return;
			}

			
	}catch(e){
		console.log("ERROR: cannot continue channel", recbuffer.depositAddress, ". No flash object file found.");
		response.writeHead(200, {'Content-Type': 'application/json'});
		response.end(JSON.stringify({accepted:false, error:'Flash channel id/deposit address file not found!'}));
		return 0;
	}		
	return;
}

// Main part
// Create server, allow connecting on port 9000
http.createServer(function (request, response) {
	
	var rawbuffer = '';
	request.on('data', function(data) {
				
		rawbuffer += data;
	});

	request.on('end', function() {
		
		var recbuffer;
		
		try
		{
			recbuffer = JSON.parse(rawbuffer);					// --- API REQUESTS
			if(typeof recbuffer != 'object' || typeof recbuffer.action != 'string')
				throw Error("Invalid request format");
		}
		catch(e)
		{
			response.writeHead(404, {'Content-Type': 'text/plain'});
			response.end('UNKNOWN REQUEST');
			return;
		}
		
		if(recbuffer.action == 'create')								// Create new Channel
		{
			console.log("Request: Create new flash channel");
			
			createChannel(recbuffer, response);
		
		}else if(recbuffer.action == 'pay')								// Receive channel payment
		{
			console.log("Request: Pay via flash channel");
			
			receivePayment(recbuffer, response, function(amount, channelRemaining){
				console.log("Successfully received", amount, "iota. Channel balance:", channelRemaining, 'iota');
			});
		}else if(recbuffer.action == 'add_digests')						// Add new multisig addresses to pool
		{
			console.log("Request: Add digests to flash channel");
			increaseDigest_pool(recbuffer, response);
			
		}else if(recbuffer.action == 'depositToRoot' || recbuffer.action == 'closeChannel')		// Special bundle (open/close)
		{
			console.log("Request: Sign special bundle.");
			receiveSpecialBundle(recbuffer, response);
			
		}else if(recbuffer.action == 'has_allowed_unconfirmed_balance')		// INFO: Unconfirmed balance in channel - transaction allowed?
		{
			console.log("Request: Has allowed unconfirmed balance.");
			
			response.writeHead(200, {'Content-Type': 'application/json'});
			response.end(JSON.stringify({	accepted: true,
						amount: ALLOWED_UNCONFIRMED_BALANCE
			}));
		}else if(recbuffer.action == 'getproviderkey')						// Security key request
		{
			console.log("Request: Send provider key");
			sendProviderKey(recbuffer, response);
		}else if(recbuffer.action == 'getdirectaddress')					// Get address for direct single payment
		{
			console.log("Request: Get single payment address");
			sendDirectAddress(recbuffer, response);			
		}else if(recbuffer.action == 'claimDeposit')				// Claim previously happened payment
		{
			console.log("Request: Claim previous deposit");
			claimDeposit(recbuffer, response);			
		}else if(recbuffer.action == 'transferUnclaimedDeposit')	// Transfer unclaimed payment value from one to another channelId/payID
		{
			console.log("Request: Transfer unclaimed deposit");
			transferDeposit(recbuffer, response);	
		}else if(recbuffer.action == 'getWebBalance')	
		{
			console.log("Request: Get Deposit balance");
			requestDepositBalance(recbuffer, response);			
		}
		else if(recbuffer.action == 'resolveIndexConflict')	
		{
			console.log("Request: Resolve index conflict");
			resolveIndexConflict(recbuffer, response);
		}
		else if(recbuffer.action == 'revertFlashRequest')	
		{
			console.log("Request: Revert channel");
			revertFlashRequest(recbuffer, response);
		}
		else 			// unknown request
		{
			console.log("Requested function",recbuffer.action,"not implemented yet!");
			
			response.writeHead(200, {'Content-Type': 'text/plain'});
			response.end('UNKNOWN REQUEST TYPE');
		}
		
	});
}).listen(PORT);

console.log("Server running, Port " + PORT + " open.");
