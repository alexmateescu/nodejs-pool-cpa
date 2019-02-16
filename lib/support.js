"use strict";
const CircularBuffer = require('circular-buffer');
const https = require('https');
const request = require('request');
const requestJson = require('request-json');
const moment = require('moment');
const debug = require('debug')('support');
const fs = require('fs');
const sprintf = require("sprintf-js").sprintf;
const nodemailer = require('nodemailer');

function circularBuffer(size) {
    let buffer = CircularBuffer(size);

    buffer.sum = function () {
        if (this.size() === 0) {
            return 1;
        }
        return this.toarray().reduce(function (a, b) {
            return a + b;
        });
    };

    buffer.average = function (lastShareTime) {
        if (this.size() === 0) {
            return global.config.pool.targetTime * 1.5;
        }
        let extra_entry = (Date.now() / 1000) - lastShareTime;
        return (this.sum() + Math.round(extra_entry)) / (this.size() + 1);
    };

    buffer.clear = function () {
        let i = this.size();
        while (i > 0) {
            this.deq();
            i = this.size();
        }
    };

    return buffer;
}

// accumulates email notifications up to one hour (email/subject -> body)
let emailAcc = {};
// last send time of email (email/subject -> time)
let emailLastSendTime = {};
let lastEmailSendTime;

function sendEmailReal(toAddress, subject, body){
    nodemailer.createTestAccount((err, account) => {
    // create reusable transporter object using the default SMTP transport
    let transporter = nodemailer.createTransport({
        host: global.config.general.emailserver, //general config URL
        port: 25,
        secure: false, // true for 465, false for other ports
        auth: {
            user: global.config.general.emailuser, // general config emailFrom
            pass: global.config.general.emailpassword // general config mailgunKey
        }
    });

    // setup email data with unicode symbols
    let mailOptions = {
        from: global.config.general.emailFrom, // sender address
        to: toAddress, // list of receivers
        subject: subject, // Subject line
        text: body, // plain text body
    };
   // send mail with defined transport object
    transporter.sendMail(mailOptions, (error, info) => {
        console.log(mailOptions)
        if (error) {
            return console.log(error);
        }
        console.log('Message sent: %s', info.messageId);
        // Preview only available when sending through an Ethereal account
        console.log('Preview URL: %s', nodemailer.getTestMessageUrl(info));
        // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>
        // Preview URL: https://ethereal.email/message/WaQKMgKddxQDoou...
    });
    });
}

function sendEmail(toAddress, subject, body, wallet){
    if (toAddress === global.config.general.adminEmail && subject.indexOf("FYI") === -1) {
        sendEmailReal(toAddress, subject, body);
    } else {
        let reEmail = /^([a-zA-Z0-9_\.-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
        if (!reEmail.test(toAddress)) {
            debug("Avoid sending email to invalid address '" + toAddress + "'");
            return;
        }
        let key = toAddress + "\t" + subject;
        if (!(key in emailAcc)) {
            emailAcc[key] = body;
            let time_now = Date.now();
            let is_fast_email = !(key in emailLastSendTime) || time_now - emailLastSendTime[key] > 6*60*60*1000;
            emailLastSendTime[key] = time_now;
            setTimeout(function(email_address, email_subject, wallet) {
                let key2 = email_address + "\t" + email_subject;
                let email_body = emailAcc[key2];
                delete emailAcc[key2];
                let emailData = {
                    wallet: wallet
                };
                sendEmailReal(email_address, email_subject, "Hello,\n\n" + email_body + "\n\nThank you,\n" + sprintf(global.config.general.emailSig, emailData));
            }, (is_fast_email ? 5 : 30)*60*1000, toAddress, subject, wallet);
        } else {
            emailAcc[key] += body;
        }
    }
}

function sendEmailAdmin(subject, body){
	sendEmail(global.config.general.adminEmail, subject, body);
}
function sendtoTelegram(toChat, msgtext){
    let reTelegram = /^([0-9][0-9][0-9][0-9][0-9])+/;
    if (!reTelegram.test(toChat) && toChat != global.config.chat_id) {
        console.error("Avoid sending telegarm to invalid address '" + toChat + "'");
        return;
    }
    let uri = "https://api.telegram.org/bot" + global.config.bot_key + "/sendmessage?chat_id=" + toChat + "&text=" + msgtext;
    request.get(uri, function(err, response, body){
        if (!err && response.statusCode === 200) {
            console.log("Message sent successfully!  Response: " + body);
        } else {
            console.error("Did not send messages to Telegram successfully!  Response: " + body + " Response: "+JSON.stringify(response));
        }
    });
}

function jsonRequest(host, port, data, is_wallet, callback, path, timeout) {
    let uri;
    if (global.config.rpc.https) {
        uri = "https://" + host + ":" + port + "/";
    } else {
        uri = "http://" + host + ":" + port + "/";
    }
    debug("JSON URI: " + uri + path + " Args: " + JSON.stringify(data));
    let client = requestJson.createClient(uri, {timeout: timeout});
    client.headers["Content-Type"] = "application/json";
    client.headers["Content-Length"] = data.length;
    client.headers["Accept"] = "application/json";
    if (is_wallet && global.config.payout.rpcPasswordEnabled && global.config.payout.rpcPasswordPath){
        fs.readFile(port === global.config.daemon.port ? global.config.payout.rpcPasswordPath : global.config.payout["rpcPasswordPath" + port.toString()], 'utf8', function(err, data){
            if (err){
                console.error("RPC password enabled, unable to read the file due to: " + JSON.stringify(err));
                return;
            }
            let passData = data.split(":");
            client.setBasicAuth(passData[0], passData[1]);
            request.post(uri, {
                auth:{
                    user: passData[0],
                    pass: passData[1],
                    sendImmediately: false
                },
                data: JSON.stringify(data)
            }, function (err, res, body) {
                if (err) {
                    return callback(err);
                }
                debug("JSON result: " + JSON.stringify(body));
                return callback(body);
            });
        });
    } else {
        client.post(path, data, function (err, res, body) {
            if (err) {
                return callback(err);
            }
            debug("JSON result: " + JSON.stringify(body));
            return callback(body);
        });
    }
}

function rpc(host, port, method, params, callback, timeout) {
    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, false, callback, 'json_rpc', timeout);
}

function rpc_wallet(host, port, method, params, callback) {
    let data = {
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    console.log(data)
    return jsonRequest(host, port, data, true, callback, 'json_rpc', 30*60*1000);
}

function rpc_new(host, port, method, params, callback, timeout) {
    let data = {
        id: 0,
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    return jsonRequest(host, port, data, false, callback, 'getheight', timeout);
}

function https_get(url, callback) {
  let timer;
  var req = https.get(url, function(res) {
    if (res.statusCode != 200) {
      console.error("URL " + url + ": Result code: " + res.statusCode);
      return callback(null);
    }
    let str = "";
    res.on('data', function(d) { str += d; });
    res.on('end', function() {
      if (timer) clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(str);
      } catch (e) {
        console.error("URL " + url + ": JSON parse exception: " + e);
        return callback(str);
      }
      return callback(json);
    });
    res.on('error', function() {
      console.error("URL " + url + ": RESPONSE ERROR!");
      return callback(null);
    });
  });
  req.on('error', function() {
    console.error("URL " + url + ": REQUEST ERROR!");
    return callback(null);
  });
  timer = setTimeout(function() {
    console.error("URL " + url + ": TIMEOUT!");
    callback(null);
  }, 30*1000);
  req.end();
}

function getAlgoHashFactor(algo, callback) {
    global.mysql.query("SELECT item_value FROM config WHERE module = 'daemon' and item = 'algoHashFactor" + algo + "'").then(function (rows) {
        if (rows.length != 1) {
	    console.error("Can't get config.daemon.algoHashFactor" + algo + " value");
            return callback(null);
        }
        callback(parseFloat(rows[0].item_value));
    });
}

function getActivePort(algo, callback) {
    global.mysql.query("SELECT item_value FROM config WHERE module = 'daemon' and item = 'activePort" + algo + "'").then(function (rows) {
        if (rows.length != 1) {
	    console.error("Can't get config.daemon.activePort" + algo + " value");
            return callback(null);
        }
        callback(parseInt(rows[0].item_value));
    });
}

function setActivePort(algo, activePort) {
    global.mysql.query("UPDATE config SET item_value = ? WHERE module = 'daemon' and item = 'activePort" + algo + "'", [activePort]);
    global.config.daemon["activePort" + algo] = activePort;
}

function formatDate(date) {
    // Date formatting for MySQL date time fields.
    return moment(date).format('YYYY-MM-DD HH:mm:ss');
}

function formatDateFromSQL(date) {
    // Date formatting for MySQL date time fields.
    let ts = new Date(date);
    return Math.floor(ts.getTime() / 1000);
}

function coinToDecimal(amount) {
    return amount / global.config.coin.sigDigits;
}

function decimalToCoin(amount) {
    return Math.round(amount * global.config.coin.sigDigits);
}

function bitcoinDecimalToCoin(amount) {
    return Math.round(amount * 100000000);
}

function bitcoinCoinToDecimal(amount) {
    return amount / 100000000;
}

function blockCompare(a, b) {
    if (a.height < b.height) {
        return 1;
    }

    if (a.height > b.height) {
        return -1;
    }
    return 0;
}

function tsCompare(a, b) {
    if (a.ts < b.ts) {
        return 1;
    }

    if (a.ts > b.ts) {
        return -1;
    }
    return 0;
}

module.exports = function () {
    return {
        rpcDaemon: function (method, params, callback) {
            rpc(global.config.daemon.address, global.config.daemon.port, method, params, callback, 30*1000);
        },
        rpcPortDaemon: function (port, method, params, callback) {
            rpc(global.config.daemon.address, port, method, params, callback, 30*1000);
        },
        rpcWallet: function (method, params, callback) {
            rpc_wallet(global.config.wallet.address, global.config.wallet.port, method, params, callback);
        },
        rpcPortWallet: function (port, method, params, callback) {
            rpc_wallet(global.config.wallet.address, port, method, params, callback);
        },
        rpcNewDaemon: function (method, params, callback) {
            rpc_new(global.config.daemon.address, global.config.daemon.port, method, params, callback, 30*1000);
        },
        circularBuffer: circularBuffer,
        formatDate: formatDate,
        coinToDecimal: coinToDecimal,
        decimalToCoin: decimalToCoin,
        bitcoinDecimalToCoin: bitcoinDecimalToCoin,
        bitcoinCoinToDecimal: bitcoinCoinToDecimal,
        formatDateFromSQL: formatDateFromSQL,
        blockCompare: blockCompare,
        sendtoTelegram: sendtoTelegram,
        sendEmail: sendEmail,
        tsCompare: tsCompare,
        getAlgoHashFactor: getAlgoHashFactor,
	getActivePort: getActivePort,
        setActivePort: setActivePort,
        https_get: https_get,
    };
};
