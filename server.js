// vim: ts=4:sw=4
//-----------------------------------------------------------------------------
// Droppy - File server in node.js
// https://github.com/silverwind/Droppy
//-----------------------------------------------------------------------------
// TODOs:
// - Test cases with special characters in filenames in both Windows and Linux
// - Add ability to navigate to subfolders
// - Multiple File operations like delete/move
// - Put the upload progress bar inside the file's list entry
// - Check for any XSS
//-----------------------------------------------------------------------------
var fileList	= {},
	resDir		= "./res/",
	server		= null,
	isUploading	= false,
	oldLen		= 0,
	fs			= require("fs"),
	formidable	= require("formidable"),
	io			= require("socket.io"),
	mime		= require("mime"),
	util		= require("util"),
	config		= require("./config.json");

"use strict";

// Read and cache the HTML and strip whitespace
var HTML = fs.readFileSync(resDir + "html.html", {"encoding": "utf8"});
HTML = HTML.replace(/(\n)/gm,"").replace(/(\t)/gm,"");

//-----------------------------------------------------------------------------
// Set up the directory for files and start the server
fs.mkdir(config.filesDir, function (err) {
	if ( !err || err.code === "EEXIST") {
		if(!config.useSSL) {
			server = require("http").createServer(onRequest);
		} else {
			var key,cert;
			try {
				key = fs.readFileSync(config.httpsKey);
				cert = fs.readFileSync(config.httpsCert);
			} catch(error) {
				logIt("Error reading required SSL certificate or key.");
				logError(error);
			}
			server = require("https").createServer({key: key, cert: cert}, onRequest);
		}
		server.listen(config.port);
		server.on("listening", function() {
			log("Listening on " + server.address().address + ":" + config.port + ".");
			io = io.listen(server, {"log level": 1});
			createWatcher();
			setupSockets();
			prepareFileList();
		});
		server.on("error", function (err) {
			if (err.code === "EADDRINUSE")
				log("Failed to bind to config.port " + config.port + ".");
			else
				logError(err);
		});
	} else {
		logError(err);
	}

});
//-----------------------------------------------------------------------------
// Watch the directory for realtime changes and send them to the client.
function createWatcher() {
	fs.watch(config.filesDir,{ persistent: true }, function(event,filename){
		if(event == "change" || event == "rename") {
			prepareFileList(function(){
				SendUpdate();
			});
		}
	});
}
//-----------------------------------------------------------------------------
// Send file list JSON over websocket
function SendUpdate() {
	if(!isUploading)
		io.sockets.emit("UPDATE_FILES", JSON.stringify(fileList));
}
//-----------------------------------------------------------------------------
// Websocket listener
function setupSockets() {
	io.sockets.on("connection", function (socket) {
		socket.on("REQUEST_UPDATE", function (data) {
			SendUpdate();
		});
		socket.on("CREATE_FOLDER", function (name) {
			fs.mkdir(config.filesDir + name, null, function(err){
				if(err) logError(err);
			});
		});
	});
}
//-----------------------------------------------------------------------------
function onRequest(req, res) {
	var method = req.method.toUpperCase();
	var socket = req.socket.remoteAddress + ":" + req.socket.remotePort;

	log("Request from " + socket + "\t" + method + "\t" + req.url);
	if (method == "GET") {
		if (req.url.match(/^\/res\//))
			handleResourceRequest(req,res,socket);
		else if (req.url.match(/^\/files\//))
			handleFileRequest(req,res,socket);
		else if (req.url.match(/^\/delete\//))
			handleDeleteRequest(req,res,socket);
		else
			getHTML(res);
	} else if (method === "POST" && req.url === "/upload") {
		handleUploadRequest(req,res,socket);
	}
}
//-----------------------------------------------------------------------------
function handleResourceRequest(req,res,socket) {
	var path = resDir + unescape(req.url.substring(resDir.length -1));
	fs.readFile(path, function (err, data) {
		if(!err) {
			fs.stat(path, function(err,stats){
				if(err) logError(err);
				log("Serving to " + socket + "\t\t" + path + " (" + convertToSI(stats.size) + ")");
				var mimeType = mime.lookup(path);
				res.writeHead(200, {
					"Content-Type"		: mimeType,
					"Content-Length"	: stats.size
				});
				res.end(data);
			});
		} else {
			logError(err);
			res.writeHead(404);
			res.end();
		}
	});
}
//-----------------------------------------------------------------------------
function handleFileRequest(req,res,socket) {
	var path = config.filesDir + unescape(req.url.substring(config.filesDir.length -1));
	if (path) {
		var mimeType = mime.lookup(path);
		fs.stat(path, function(err,stats){
			if(err) logError(err);
			log("Serving to " + socket + "\t\t" + path + " (" + convertToSI(stats.size) + ")");
			res.writeHead(200, {
				"Content-Type"		: mimeType,
				"Content-Length"	: stats.size
			});
			fs.createReadStream(path, {"bufferSize": 4096}).pipe(res);
		});
	}
}
//-----------------------------------------------------------------------------
function handleDeleteRequest(req,res,socket) {
	fs.readdir(config.filesDir, function(err, files){
		if(!err) {
			var path = config.filesDir + req.url.replace(/^\/delete\//,"");
			log("Deleting " + path);
			try {
				var stats = fs.statSync(unescape(path));
				if (stats.isFile()) {
					fs.unlink(unescape(path), function(err){
						if(err) logError(err);
					});
				} else if (stats.isDirectory()){
					fs.rmdir(unescape(path), function(err){
						if(err) logError(err);
					});
				}
				res.writeHead(200, {
					"Content-Type" : "text/html"
				});
				res.end();
			} catch(error) {
				logError(error);
				res.writeHead(500);
				res.end();
			}
		} else {
			logError(err);
			res.writeHead(500);
			res.end();
		}
	});
}
//-----------------------------------------------------------------------------
function handleUploadRequest(req,res,socket) {
	if (req.url == "/upload" ) {
		var form = new formidable.IncomingForm();
		form.uploadDir = config.filesDir;
		form.parse(req);
		form.on("fileBegin", function(name, file) {
			isUploading = true;
			log("Receiving from " + socket + ":\t\t" + file.name );
			file.path = form.uploadDir + "/" + file.name;
		});
		form.on('end', function() {
			isUploading = false;
		});

		form.on("error", function(err) {
			logError(err);
		});

		res.writeHead(200, {
			"Content-Type" : "text/html"
		});
		res.end();
	}
}
//-----------------------------------------------------------------------------
function getHTML(res) {
	res.writeHead(200, {"content-type": "text/html"});
	res.end(HTML);
}
//-----------------------------------------------------------------------------
function prepareFileList(callback){
	function ReadDir(){
		fileList = {};
		fs.readdir(config.filesDir, function(err,files) {
			if (oldLen === files.len) return; //skip if no new files added/removed
			if(err) logError(err);
			for(i=0,len=files.length;i<len;i++){
				var name = files[i], type;
				try{
					var stats = fs.statSync(config.filesDir + name);
					if (stats.isFile())
						type = "f";
					if (stats.isDirectory())
						type = "d";
					if (type == "f" || type == "d") {
						fileList[i] = {"name": name, "type": type, "size" : stats.size};
					}
				} catch(error) {
					logError(error);
				}
			}
			oldlen = files.length;
			if(callback !== undefined) callback();
		});
	}
	throttle(ReadDir(),500);
}
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
function log(msg) {
	console.log(getTimestamp() + msg);
}

function logError(err) {
	if (typeof err === "object") {
		if (err.message)
			log(err.message);
		if (err.stack)
			log(err.stack);
	}
}

process.on("uncaughtException", function (err) {
	log("=============== Uncaught exception! ===============");
	logError(err);
});
//-----------------------------------------------------------------------------
//Throttle helper function
//Source: http://remysharp.com/2010/07/21/throttling-function-calls/
function throttle(fn, threshhold, scope) {
	if(!threshhold) threshhold = 250;
	var last,deferTimer;
	return function () {
		var context = scope || this;
		var now = new Date();
		var args = arguments;
		if (last && now < last + threshhold) {
			clearTimeout(deferTimer);
			deferTimer = setTimeout(function () {
				last = now;
				fn.apply(context, args);
			}, threshhold);
		} else {
			last = now;
			fn.apply(context, args);
		}
	};
}
//-----------------------------------------------------------------------------
function getTimestamp() {
	var currentDate = new Date();
	var day = currentDate.getDate();
	var month = currentDate.getMonth() + 1;
	var year = currentDate.getFullYear();
	var hours = currentDate.getHours();
	var minutes = currentDate.getMinutes();
	var seconds = currentDate.getSeconds();

	if (hours < 10) hours = "0" + hours;
	if (minutes < 10) minutes = "0" + minutes;
	if (seconds < 10) seconds = "0" + seconds;

	return month + "/" + day + "/" + year + " "+ hours + ":" + minutes + ":" + seconds + " ";
}
//-----------------------------------------------------------------------------
function convertToSI(bytes) {
	var suffix = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"], tier = 0;

	while(bytes >= 1024) {
		bytes /= 1024;
		tier++;
	}
	return Math.round(bytes * 10) / 10 + " " + suffix[tier];
}