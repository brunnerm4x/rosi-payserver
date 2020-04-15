# ROSI Payment-Server

## ROSI Payment System - Provider Flash-Channel Server

### General Information on ROSI:
* https://rosipay.net (General User Information, Links)
* https://github.com/brunnerm4x/rosi (Main Github Repository)

### Description
This is the heart of the Provider Software - this server handles every payment request from the client - this server has to be made accessable from outside.

### Dependencies 
* NodeJs (https://nodejs.org) 

### Installation
1. `git clone https://github.com/brunnerm4x/rosi-payserver.git`
2. `cd rosi-payserver/`
3. `npm i`

### Configuration
Main config can be done using npm (examples, see package.json):
* `npm config set rosi-payserver:port 9000` (to set the port the server should listen)
* `npm config set rosi-payserver:allowedUnconfirmed 100` (Allwed balance in iota to be spent while funding transaction of channel is unconfirmed (but seen by own node!))

Note: it is possible to start the server with a temporary port with `npm run start --rosi-payserver:port=XXXX`, this also works for other npm configs.

### Run the Server
1. `npm start`

